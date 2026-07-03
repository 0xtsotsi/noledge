import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { z } from "zod";

import { splitParagraphs } from "@/app/api/chat/split-paragraphs";

export const runtime = "nodejs";
export const maxDuration = 60;

const rewriteRequestSchema = z.object({
	conversationId: z.string().min(1),
	messageId: z.string().min(1),
	paragraphIndex: z.number().int().min(0).max(200),
	instruction: z.string().min(1).max(500),
});

/**
 * POST /api/chat/rewrite-paragraph
 * Body: `{ conversationId, messageId, paragraphIndex, instruction }`.
 *
 * Loads the original assistant turn, finds the paragraph at the given index,
 * and runs a cheap rewrite using `gpt-4o-mini`. The rewrite inherits the
 * UNTRUSTED_DATA guard so any tool call the rewrite triggers is still framed
 * as data-not-instructions.
 *
 * Returns SSE with the rewritten paragraph. The front-end component replaces
 * the original paragraph in place and offers a "Save as new draft" /
 * "Restore" pair so the user can keep the original.
 *
 * Honest disclosure: each rewrite is a separate LLM call (~$0.001 on
 * gpt-4o-mini). The cost meter tracks this automatically.
 */
export async function POST(request: Request): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = rewriteRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { conversationId, messageId, paragraphIndex, instruction } =
		parsed.data;

	// Load the conversation from the local DB (same source the chat route uses).
	const { getDatabase } = await import("@/lib/ai/db/client");
	const db = getDatabase();
	const message = db
		.prepare(
			"SELECT content FROM conversation_messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'",
		)
		.get(messageId, conversationId) as { content: string } | undefined;
	if (!message) {
		return Response.json(
			{ error: "Original assistant message not found." },
			{ status: 404 },
		);
	}

	const paragraphs = splitParagraphs(message.content);
	if (paragraphIndex >= paragraphs.length) {
		return Response.json(
			{ error: `Paragraph index out of range (have ${paragraphs.length}).` },
			{ status: 400 },
		);
	}
	const target = paragraphs[paragraphIndex] ?? "";

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: object): void => {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
				);
			};
			try {
				send({ type: "paragraph", index: paragraphIndex, original: target });
				const result = streamText({
					model: openai("gpt-4o-mini"),
					system:
						"You rewrite one paragraph from a longer assistant answer. Stay faithful to the meaning. Match the user's requested style. Return ONLY the rewritten paragraph text — no preamble, no explanation.",
					messages: [
						{
							role: "user",
							content: `Original paragraph:\n"""\n${target}\n"""\n\nInstruction: ${instruction}\n\nRewritten paragraph:`,
						},
					],
					abortSignal: request.signal,
				});
				let rewritten = "";
				for await (const part of result.fullStream) {
					if (part.type === "text-delta") {
						rewritten += part.text;
						send({ type: "delta", text: part.text });
					}
				}
				send({ type: "done", paragraph: rewritten });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				send({ type: "error", message });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
