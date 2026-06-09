import { stepCountIs, streamText } from "ai";
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
			"INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
		).run(conversationId, title, now, now);
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
					tools: createKnowledgeTools(request.signal),
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
				controller.close();
			}
		},
	});

	return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
	return {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
	};
}
