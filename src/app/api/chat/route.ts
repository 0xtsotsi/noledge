import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { stepCountIs, streamText, type Tool } from "ai";
import { z } from "zod";
import { buildModelMessages } from "@/lib/ai/chat/attachments";
import {
	buildToolSystemPrompt,
	RESPONSE_STYLE_IDS,
	type ResponseStyleId,
	toSources,
} from "@/lib/ai/chat/prompt";
import {
	type ChatReasoningStep,
	type ChatSource,
	type ChatStreamChunk,
	encodeChunk,
} from "@/lib/ai/chat/sse";
import { createKnowledgeTools, type RecentDocument } from "@/lib/ai/chat/tools";
import { getDatabase } from "@/lib/ai/db/client";
import { refreshExpiredOAuthCredentials } from "@/lib/ai/models/oauth";
import { resolveModel } from "@/lib/ai/models/registry";
import { getAppSetting } from "@/lib/ai/settings";

const textPartSchema = z.object({
	type: z.literal("text"),
	text: z.string(),
});

const filePartSchema = z.object({
	type: z.literal("file"),
	name: z.string(),
	mediaType: z.string(),
	data: z.string(),
});

const partSchema = z.discriminatedUnion("type", [
	textPartSchema,
	filePartSchema,
]);

const messageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	parts: z.array(partSchema),
});

const bodySchema = z.object({
	messages: z.array(messageSchema).min(1),
	/** Existing conversation to append to; omitted for a brand-new chat. */
	conversationId: z.string().min(1).optional(),
	/** Title for a newly created conversation (server derives one if omitted). */
	title: z.string().min(1).max(200).optional(),
	/** False for regenerate: reuse the existing latest user turn. */
	appendUser: z.boolean().optional().default(true),
	model: z.string().optional(),
	useRag: z.boolean().optional().default(true),
	/** Enable the model's reasoning/thinking trace (only affects capable models). */
	thinking: z.boolean().optional().default(true),
	/** Opt-in to the provider's web search tool for this turn (Anthropic webSearch / OpenAI webSearchPreview). */
	webSearch: z.boolean().optional().default(false),
	/** Browser IANA time zone used for dynamic date instructions. */
	timeZone: z.string().min(1).optional().default("UTC"),
});

function recentDocumentSource(document: RecentDocument): {
	id: string;
	href: string;
	title: string;
	description: string;
} {
	const date = new Date(document.date).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
	return {
		id: document.id,
		href: "/knowledge",
		title: document.title,
		description: document.publishedAt
			? `Published ${date}`
			: `Ingested ${date}`,
	};
}

function makeTitle(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 60) return trimmed;
	return `${trimmed.slice(0, 57)}…`;
}

type AssistantPayload = {
	reasoning?: string;
	sources?: ChatSource[];
	steps?: ChatReasoningStep[];
};

/**
 * Default user id for the single-user Noledge deployment. Feature 5 (AI
 * Recall) keys cross-account memory on `conversations.user_id`; multi-user
 * setups will plumb a per-request id from the auth layer into this constant
 * (or replace it with a function). For v1 everything is "default".
 */
const DEFAULT_USER_ID = "default";

/**
 * Persist a one-sentence summary of the (user question → assistant answer)
 * pair into `recall_user_context` so the cross-memory search
 * (`src/lib/ai/search/cross-memory.ts`) can find it later. Fire-and-forget:
 * the response has already been streamed to the user by the time this runs,
 * so a summary failure never affects the user-visible stream. We also skip
 * summarisation entirely when no GG-compatible provider is configured — the
 * cheap `gpt-4o-mini` call costs ~$0.0005 per turn, but a missing key would
 * surface as an exception every turn, polluting the logs.
 */
function persistRecallSummary(
	conversationId: string,
	userText: string,
	assistantText: string,
): void {
	if (!userText.trim() || !assistantText.trim()) return;
	void (async () => {
		try {
			const { openai } = await import("@ai-sdk/openai");
			const { generateText } = await import("ai");
			const result = await generateText({
				model: openai("gpt-4o-mini"),
				system:
					"Summarise the user's question and the assistant's answer in ONE sentence (max 25 words). Be specific: names, numbers, dates. The summary will be indexed for cross-session memory recall.",
				messages: [
					{
						role: "user",
						content: `User asked: ${userText.slice(0, 500)}\n\nAssistant answered: ${assistantText.slice(0, 1500)}\n\nOne-sentence summary:`,
					},
				],
			});
			const summary = result.text.trim();
			if (!summary) return;
			const db = getDatabase();
			db.prepare(
				"INSERT INTO recall_user_context (id, user_id, conversation_id, query, summary, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(
				`recall-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				DEFAULT_USER_ID,
				conversationId,
				userText.slice(0, 200),
				summary.slice(0, 500),
				null,
				Date.now(),
			);
		} catch (error) {
			// Best-effort. Logged but never propagated — the user-visible
			// stream has already completed.
			console.warn("[chat] recall summary failed:", error);
		}
	})();
}

/**
 * Persist the latest user message server-side before streaming, creating the
 * conversation when needed, so a closed tab can never lose the turn. Returns
 * the (possibly new) conversation id.
 */
function persistUserTurn(
	options: Readonly<{
		conversationId: string | undefined;
		title: string | undefined;
		userText: string;
		appendUser: boolean;
	}>,
): string {
	const db = getDatabase();
	const now = Date.now();

	const existing = options.conversationId
		? (db
				.prepare("SELECT id FROM conversations WHERE id = ?")
				.get(options.conversationId) as { id: string } | undefined)
		: undefined;

	if (existing) {
		const conversationId = existing.id;
		if (!options.appendUser) return conversationId;
		db.transaction(() => {
			const next = db
				.prepare(
					"SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM conversation_messages WHERE conversation_id = ?",
				)
				.get(conversationId) as { next: number };
			db.prepare(
				"INSERT INTO conversation_messages (id, conversation_id, role, content, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			).run(
				`${conversationId}-m${next.next}-${now}`,
				conversationId,
				"user",
				options.userText,
				next.next,
				now,
			);
			db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
				now,
				conversationId,
			);
		})();
		return conversationId;
	}

	const conversationId = `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const title =
		options.title ??
		(options.userText ? makeTitle(options.userText) : "New chat");
	db.transaction(() => {
		db.prepare(
			"INSERT INTO conversations (id, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?)",
		).run(conversationId, title, now, now, DEFAULT_USER_ID);
		db.prepare(
			"INSERT INTO conversation_messages (id, conversation_id, role, content, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			`${conversationId}-m0-${now}`,
			conversationId,
			"user",
			options.userText,
			0,
			now,
		);
	})();
	return conversationId;
}

/**
 * Persist the assistant turn (text + structured payload) at stream end. Runs
 * even when the client disconnected mid-stream, so partial answers survive.
 * Best-effort: persistence failure must never break stream teardown.
 */
function persistAssistantTurn(
	conversationId: string,
	text: string,
	payload: AssistantPayload,
): void {
	if (text.trim().length === 0 && !payload.reasoning) return;
	try {
		const db = getDatabase();
		const now = Date.now();
		const payloadJson =
			Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
		db.transaction(() => {
			const next = db
				.prepare(
					"SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM conversation_messages WHERE conversation_id = ?",
				)
				.get(conversationId) as { next: number };
			db.prepare(
				"INSERT INTO conversation_messages (id, conversation_id, role, content, ordinal, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(
				`${conversationId}-m${next.next}-${now}`,
				conversationId,
				"assistant",
				text,
				next.next,
				now,
				payloadJson,
			);
			db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
				now,
				conversationId,
			);
		})();
	} catch (error) {
		console.error("[chat] failed to persist assistant turn", error);
	}
}

function toolStepFor(part: {
	toolCallId: string;
	toolName: string;
	input: unknown;
}): ChatReasoningStep {
	if (part.toolName === "searchKnowledge") {
		const query =
			typeof part.input === "object" &&
			part.input !== null &&
			"query" in part.input &&
			typeof part.input.query === "string"
				? part.input.query
				: "knowledge";
		return {
			id: part.toolCallId,
			label: `Searched brain for "${query}"`,
			detail: "",
		};
	}
	return {
		id: part.toolCallId,
		label: "Listed recent documents",
		detail: "",
	};
}

function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return "Something went wrong while generating a response.";
	}

	const message = error.message;
	const normalized = message.toLowerCase();
	if (
		normalized.includes("rate limit") ||
		normalized.includes("quota") ||
		normalized.includes("usage limit")
	) {
		return `Provider usage/rate limit reached: ${message}`;
	}

	return `Something went wrong: ${message}`;
}

export async function POST(request: Request): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const {
		messages,
		conversationId,
		title,
		appendUser,
		model,
		useRag,
		thinking,
		webSearch,
		timeZone,
	} = parsed.data;

	await refreshExpiredOAuthCredentials();
	const resolved = resolveModel(model, { thinking });
	if (!resolved.ok) {
		return Response.json({ error: resolved.error }, { status: 422 });
	}

	const modelMessages = await buildModelMessages(messages, {
		supportsVision: resolved.supportsVision,
		supportsPdf: resolved.supportsPdf,
		signal: request.signal,
	});

	// Persist the user turn before streaming so a closed tab cannot lose it.
	const lastMessage = messages[messages.length - 1];
	const userText =
		lastMessage?.role === "user"
			? lastMessage.parts
					.filter(
						(part): part is { type: "text"; text: string } =>
							part.type === "text",
					)
					.map((part) => part.text)
					.join("\n")
					.trim()
			: "";
	const activeConversationId = persistUserTurn({
		conversationId,
		title,
		userText,
		appendUser,
	});

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const aborted = (): boolean => request.signal.aborted;
			const emittedSources = new Set<string>();
			// Accumulated assistant turn, persisted server-side at stream end (even
			// on abort/disconnect) so the answer survives a closed tab.
			let assistantText = "";
			let assistantReasoning = "";
			const assistantSources: ChatSource[] = [];
			const assistantSteps: ChatReasoningStep[] = [];
			// The model can emit text across multiple steps (e.g. a sentence before a
			// tool call, then the real answer after the tool result). Those segments
			// stream as separate `text-delta` parts and would otherwise be concatenated
			// with no separation ("…searches.I can't see…"). Track segment boundaries
			// so we can insert a paragraph break between them.
			let emittedText = false;
			let separatorPending = false;
			// Reasoning streams as its own sequence of deltas; accumulate the same way
			// and break between distinct reasoning segments (one per step).
			let emittedReasoning = false;
			let reasoningSeparatorPending = false;
			try {
				// First event: the conversation id, so the client can adopt it.
				controller.enqueue(
					encodeChunk({ type: "conversation", id: activeConversationId }),
				);
				const agentSystemPrompt = getAppSetting("agent.systemPrompt");
				const aboutUser = getAppSetting("agent.aboutUser");
				const responseStyle = getAppSetting("agent.responseStyle");
				const style =
					responseStyle === "no-bullshit" || responseStyle === "to-the-point"
						? "no-bullshit-to-the-point"
						: RESPONSE_STYLE_IDS.includes(responseStyle as ResponseStyleId)
							? (responseStyle as ResponseStyleId)
							: "default";
				const result = streamText({
					model: resolved.model,
					system: buildToolSystemPrompt(new Date(), timeZone, {
						anthropicOAuth:
							resolved.provider === "anthropic" &&
							resolved.credentialSource === "oauth",
						...(agentSystemPrompt ? { systemPrompt: agentSystemPrompt } : {}),
						...(aboutUser ? { aboutUser } : {}),
						responseStyle: style,
					}),
					messages: modelMessages,
					tools: buildChatTools({
						baseTools: createKnowledgeTools(request.signal),
						webSearch,
						modelId: resolved.modelId,
						provider: resolved.provider,
					}),
					providerOptions: resolved.providerOptions,
					// Grounding is enforced via the system prompt (always search before
					// answering). We keep tool choice on "auto" rather than forcing a tool
					// call, because reasoning models reject a forced tool_choice while
					// thinking is enabled.
					toolChoice: useRag ? "auto" : "none",
					stopWhen: stepCountIs(6),
					abortSignal: request.signal,
				});

				for await (const part of result.fullStream) {
					if (aborted()) break;
					if (part.type === "reasoning-start") {
						if (emittedReasoning) reasoningSeparatorPending = true;
						continue;
					}
					if (part.type === "reasoning-delta") {
						if (part.text.length === 0) continue;
						const text = reasoningSeparatorPending
							? `\n\n${part.text}`
							: part.text;
						reasoningSeparatorPending = false;
						emittedReasoning = true;
						assistantReasoning += text;
						controller.enqueue(encodeChunk({ type: "reasoning", text }));
						continue;
					}
					if (part.type === "text-start") {
						if (emittedText) separatorPending = true;
						continue;
					}
					if (part.type === "text-delta") {
						if (part.text.length === 0) continue;
						const text = separatorPending ? `\n\n${part.text}` : part.text;
						separatorPending = false;
						emittedText = true;
						assistantText += text;
						controller.enqueue(encodeChunk({ type: "text", text }));
						continue;
					}
					if (part.type === "tool-call" && !part.dynamic) {
						const step = toolStepFor(part);
						assistantSteps.push(step);
						controller.enqueue(encodeChunk({ type: "step", step }));
						continue;
					}
					if (part.type === "tool-result" && !part.dynamic) {
						if (part.toolName === "searchKnowledge" && part.output.ok) {
							for (const source of toSources(part.output.chunks)) {
								if (emittedSources.has(source.id)) continue;
								emittedSources.add(source.id);
								assistantSources.push(source);
								controller.enqueue(encodeChunk({ type: "source", source }));
							}
							continue;
						}
						if (part.toolName === "listRecentDocuments" && part.output.ok) {
							for (const document of part.output.documents) {
								if (emittedSources.has(document.id)) continue;
								emittedSources.add(document.id);
								const source = recentDocumentSource(document);
								assistantSources.push(source);
								controller.enqueue(encodeChunk({ type: "source", source }));
							}
							continue;
						}
					}
					if (part.type === "tool-error") {
						console.warn("[chat] tool error", {
							toolName: part.toolName,
							toolCallId: part.toolCallId,
							error: errorMessage(part.error),
						});
						continue;
					}
					if (part.type === "error") {
						controller.enqueue(
							encodeChunk({ type: "error", message: errorMessage(part.error) }),
						);
						break;
					}
					if (part.type === "finish-step" && part.finishReason === "length") {
						const notice = emittedText
							? "\n\nThe model hit its output limit before finishing. Try asking for fewer sources or a narrower time window."
							: "The model hit its output limit before it could answer. Try asking for fewer sources or a narrower time window.";
						assistantText += notice;
						controller.enqueue(encodeChunk({ type: "text", text: notice }));
						break;
					}
				}

				controller.enqueue(
					encodeChunk({ type: "done" } satisfies ChatStreamChunk),
				);
			} catch (error) {
				if (!aborted()) {
					controller.enqueue(
						encodeChunk({
							type: "error",
							message: errorMessage(error),
						}),
					);
					controller.enqueue(encodeChunk({ type: "done" }));
				}
			} finally {
				// Runs even on abort/disconnect — the route owns the stream — so a
				// partially generated answer is still saved.
				persistAssistantTurn(activeConversationId, assistantText, {
					...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
					...(assistantSources.length > 0 ? { sources: assistantSources } : {}),
					...(assistantSteps.length > 0 ? { steps: assistantSteps } : {}),
				});
				// Feature 5: persist a one-sentence summary so the cross-memory
				// search can find this turn later. Fire-and-forget — the response
				// has already been streamed.
				persistRecallSummary(activeConversationId, userText, assistantText);
				controller.close();
			}
		},
	});

	return new Response(stream, { headers: sseHeaders() });
}

/**
 * Combine the always-on knowledge tools with the provider's web-search tool,
 * gated on (a) the user explicitly enabling web search and (b) the resolved
 * model supporting it. Currently:
 *   - Anthropic models -> anthropic.tools.webSearch_20260209 (max 5 uses)
 *   - OpenAI models    -> openai.tools.webSearchPreview()
 * The untrusted-data framing in  covers any web
 * snippet that lands in the conversation, so the same threat model applies.
 */
type ChatToolsOptions = Readonly<{
	baseTools: ReturnType<typeof createKnowledgeTools>;
	webSearch: boolean;
	modelId: string;
	provider: import("@/lib/ai/models/types").ProviderId;
}>;

function buildChatTools({
	baseTools,
	webSearch,
	modelId,
	provider,
}: ChatToolsOptions): Record<string, Tool> {
	const tools: Record<string, Tool> = { ...baseTools };
	if (!webSearch) return tools;
	const id = modelId.toLowerCase();
	if (provider === "anthropic" && id.startsWith("claude-")) {
		tools.webSearch = anthropic.tools.webSearch_20260209({ maxUses: 5 });
		return tools;
	}
	if (
		provider === "openai" &&
		(id.startsWith("gpt-") || id.startsWith("o3") || id.startsWith("o4"))
	) {
		tools.webSearch = openai.tools.webSearchPreview({});
		return tools;
	}
	// Web search requested but provider/model doesn't support it in our adapter.
	// Silently fall back to knowledge-only rather than 500-ing the turn.
	return tools;
}

function sseHeaders(): HeadersInit {
	return {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
	};
}
