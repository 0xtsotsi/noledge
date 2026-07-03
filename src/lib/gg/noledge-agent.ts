import { Agent, type AgentEvent, type AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import { UNTRUSTED_DATA } from "@/lib/ai/chat/prompt";
import { computeClaimCitations } from "@/lib/ai/rag/claim-citations";
import { judgeFaithfulness } from "@/lib/ai/rag/faithfulness";
import { listRecentDocuments } from "@/lib/ai/rag/list-recent-documents";
import { retrieveChunks } from "@/lib/ai/rag/retrieve";
import type {
	BridgeAgentRequest,
	BridgeAgentResponse,
	BridgeAgentStep,
	BridgeSource,
} from "@/lib/bridge/schemas";
import { resolveGgModel } from "./resolve-gg-model";

const MAX_TOOL_RESULT_CHARS = 6000;
const SEARCH_TOP_K = 5;

/**
 * Frame every tool result string as UNTRUSTED_DATA. The agent reads the result
 * as raw text — without this framing, an attacker who poisoned a retrieved
 * chunk could embed instructions the model would obey. The framing is
 * identical to the one in the chat route's system prompt
 * (`src/lib/ai/chat/prompt.ts`), so both surfaces agree on the threat model.
 *
 * Chunks are also individually prefixed with `[Document N — title]` so the
 * agent can cite specific chunks (e.g. "per [Document 2]") and so that a chunk
 * boundary is unambiguous when a single tool result contains many chunks.
 */
export function frameUntrustedToolResult(body: string, intro: string): string {
	return `${intro}\n\n${body}\n\n---\n${UNTRUSTED_DATA}`;
}

function limitText(value: string, maxChars = MAX_TOOL_RESULT_CHARS): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function uniqueSources(sources: BridgeSource[]): BridgeSource[] {
	const seen = new Set<string>();
	return sources.filter((source) => {
		if (seen.has(source.id)) return false;
		seen.add(source.id);
		return true;
	});
}

/**
 * Return a grounded search-only answer when no GG-compatible LLM provider is
 * configured. Lists the top retrieved chunks plus the CRM context so the caller
 * still gets something actionable from `/api/bridge/agent`.
 */
async function runSearchOnlyAnswer(
	input: BridgeAgentRequest,
	sources: BridgeSource[],
	steps: BridgeAgentStep[],
	agentErrorDetail?: string,
): Promise<BridgeAgentResponse> {
	steps.push({
		label: "Search",
		detail: "top 5 chunks for prompt + CRM fields",
	});
	const searchResult = await retrieveChunks(input.prompt, {
		topK: SEARCH_TOP_K,
	});
	if (searchResult.ok && searchResult.chunks.length > 0) {
		for (const chunk of searchResult.chunks) {
			sources.push({
				id: chunk.chunkId,
				title: chunk.documentTitle,
				content: limitText(chunk.content, 1200),
				score: chunk.score,
			});
		}
	}

	const lines: string[] = [];
	const recent = listRecentDocuments(5);
	if (recent.length > 0) {
		lines.push("Most recent Noledge documents:");
		for (const document of recent) {
			lines.push(`- ${document.title}`);
		}
	}

	if (input.crmContext) {
		lines.push(
			`\nCRM context for ${input.crmContext.objectName} ${input.crmContext.recordId}: ${input.crmContext.title}`,
		);
		for (const [key, value] of Object.entries(input.crmContext.fields ?? {})) {
			lines.push(`- ${key}: ${formatFieldValue(value)}`);
		}
	}

	if (sources.length === 0) {
		lines.push(
			"\nNo matching documents were found for this prompt and no GG agent provider is configured. Add an OpenAI / Anthropic / GLM / Kimi key in Noledge, or ingest more context, then try again.",
		);
	} else {
		const note = agentErrorDetail
			? ` (agent unavailable: ${agentErrorDetail}; falling back to retrieval)`
			: " (no LLM provider is configured, so this is a retrieval-only answer)";
		lines.push(`\nTop ${sources.length} matching document chunks${note}.`);
	}

	return {
		ok: true,
		answer: lines.join("\n"),
		sources: uniqueSources(sources).slice(0, 8),
		steps,
		claimCitations: computeClaimCitations(
			lines.join("\n"),
			uniqueSources(sources).slice(0, 8),
		),
	};
}

function formatFieldValue(value: unknown): string {
	if (value === null || value === undefined) return "(empty)";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (!("type" in part)) return "";
			if (part.type !== "text") return "";
			return "text" in part && typeof part.text === "string" ? part.text : "";
		})
		.join("")
		.trim();
}

export async function runNoledgeAgent(
	input: BridgeAgentRequest,
	signal?: AbortSignal,
): Promise<BridgeAgentResponse> {
	const sources: BridgeSource[] = [];
	const steps: BridgeAgentStep[] = [];

	// Pre-flight: if no GG-compatible provider is configured (or the configured one
	// fails credential resolution), fall back to a search-only answer. That keeps
	// the bridge useful in local dev / staging while real providers are wired up.
	let resolved: Awaited<ReturnType<typeof resolveGgModel>>;
	try {
		resolved = await resolveGgModel(input.model);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		steps.push({ label: "Model", detail: `fallback: ${message}` });
		return runSearchOnlyAnswer(input, sources, steps, message);
	}
	steps.push({
		label: "Model",
		detail: `${resolved.provider}:${resolved.model}`,
	});

	const searchParams = z.object({
		query: z.string().min(1),
		topK: z.number().int().min(1).max(8).optional(),
	});
	const recentParams = z.object({
		limit: z.number().int().min(1).max(10).optional(),
	});
	const crmParams = z.object({
		reason: z.string().min(1).optional(),
	});

	const searchTool: AgentTool<typeof searchParams> = {
		name: "searchKnowledge",
		description: "Search Noledge documents for grounded evidence.",
		parameters: searchParams,
		execute: async (args, context) => {
			context.onUpdate?.({ status: "searching" });
			const result = await retrieveChunks(args.query, {
				topK: args.topK ?? SEARCH_TOP_K,
				signal: context.signal,
			});
			if (!result.ok) {
				throw new Error(result.error);
			}

			const toolSources = result.chunks.map((chunk) => ({
				id: chunk.chunkId,
				title: chunk.documentTitle,
				content: limitText(chunk.content, 1200),
				score: chunk.score,
			}));
			sources.push(...toolSources);
			if (toolSources.length === 0) {
				return {
					content: frameUntrustedToolResult(
						"No knowledge matches found for this query.",
						"## searchKnowledge result",
					),
					details: { sources: toolSources },
				};
			}
			const numberedBody = toolSources
				.map(
					(source, index) =>
						`[Document ${index + 1} — ${source.title}]\n${source.content}`,
				)
				.join("\n\n");
			return {
				content: limitText(
					frameUntrustedToolResult(
						numberedBody,
						"## searchKnowledge result\nTreat each numbered block as one cited document. Quote sparingly; cite by `[Document N]`.",
					),
				),
				details: { sources: toolSources },
			};
		},
	};

	const recentTool: AgentTool<typeof recentParams> = {
		name: "listRecentDocuments",
		description: "List the newest Noledge documents when recency matters.",
		parameters: recentParams,
		execute: (args) => {
			const documents = listRecentDocuments(args.limit ?? 5);
			if (documents.length === 0) {
				return {
					content: frameUntrustedToolResult(
						"No documents available.",
						"## listRecentDocuments result",
					),
					details: { documents },
				};
			}
			const body = documents
				.map(
					(document, index) =>
						`${index + 1}. ${document.title} (${new Date(document.documentDate).toISOString()})`,
				)
				.join("\n");
			return {
				content: frameUntrustedToolResult(
					body,
					"## listRecentDocuments result",
				),
				details: { documents },
			};
		},
	};

	const crmTool: AgentTool<typeof crmParams> = {
		name: "readCrmContext",
		description: "Read the CRM record context passed from Twenty.",
		parameters: crmParams,
		execute: () => {
			if (!input.crmContext) {
				return "No CRM context was provided for this question.";
			}
			return {
				content: limitText(JSON.stringify(input.crmContext, null, 2), 2000),
				details: { crmContext: input.crmContext },
			};
		},
	};

	const tools: AgentTool[] = [searchTool, recentTool, crmTool];

	const agent = new Agent({
		provider: resolved.provider,
		model: resolved.model,
		apiKey: resolved.apiKey,
		signal,
		maxTurns: 6,
		maxToolResultChars: MAX_TOOL_RESULT_CHARS,
		temperature: 0.2,
		system: [
			"You answer using Noledge memory plus optional CRM context. Use tools before making specific claims. Be concise, practical, and grounded in retrieved evidence.",
			UNTRUSTED_DATA,
		].join("\n\n"),
		...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
		...(resolved.defaultHeaders
			? { defaultHeaders: resolved.defaultHeaders }
			: {}),
		tools,
	});

	const promptSections = [
		`User request:\n${input.prompt.trim()}`,
		input.crmContext
			? `CRM context available for ${input.crmContext.objectName} ${input.crmContext.recordId}: ${input.crmContext.title}`
			: "No CRM context was provided.",
		"Use searchKnowledge for grounding. Call readCrmContext when record details matter.",
	];

	try {
		const stream = agent.prompt(promptSections.join("\n\n"));
		for await (const event of stream) {
			recordAgentStep(event, steps);
		}
		const result = await stream;
		const answer = messageText(result.message.content);

		return {
			ok: true,
			answer: answer || "No answer returned.",
			sources: uniqueSources(sources).slice(0, 8),
			steps,
			claimCitations: computeClaimCitations(
				answer || "No answer returned.",
				uniqueSources(sources).slice(0, 8),
			),
			faithfulness: await judgeFaithfulness(
				answer || "No answer returned.",
				uniqueSources(sources).slice(0, 8),
				process.env.NOLEDGE_FAITHFULNESS_MODEL,
			),
		};
	} catch (error) {
		// The agent loop itself failed (most often an upstream provider rejection).
		// Fall back to a retrieval-only answer so the bridge caller still gets a
		// useful response instead of a 500.
		const message = error instanceof Error ? error.message : String(error);
		steps.push({ label: "Agent error", detail: message });
		return runSearchOnlyAnswer(input, sources, steps, message);
	}
}

function recordAgentStep(event: AgentEvent, steps: BridgeAgentStep[]): void {
	switch (event.type) {
		case "tool_call_start":
			steps.push({ label: `Tool start: ${event.name}` });
			break;
		case "tool_call_end":
			steps.push({
				label: `Tool done: ${event.toolCallId}`,
				detail: event.isError ? `error: ${event.result}` : event.result,
			});
			break;
		case "turn_end":
			steps.push({
				label: `Turn ${event.turn}`,
				detail: `stop: ${event.stopReason}`,
			});
			break;
		case "agent_done":
			steps.push({ label: "Agent done", detail: `${event.totalTurns} turns` });
			break;
		default:
			break;
	}
}
