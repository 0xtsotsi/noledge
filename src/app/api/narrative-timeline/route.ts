import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { z } from "zod";
import { perRecordTimeline } from "@/lib/ai/retrieval/per-record-timeline";
import { validateBridgeRequest } from "@/lib/bridge/auth";

export const runtime = "nodejs";

const narrativeRequestSchema = z.object({
	objectName: z.enum(["company", "person", "opportunity"]),
	recordId: z.string().min(1),
	question: z.string().max(500).optional(),
});

/**
 * POST /api/narrative-timeline
 * Body: `{ objectName, recordId, question? }`.
 *
 * Returns an SSE stream of the synthesised narrative. The front-end tab
 * renders the streamed text and (optionally) a follow-up question input.
 *
 * The synthesis uses `gpt-4o-mini` — cheap, plenty for narrative prose.
 * A "what was true then that isn't now?" follow-up runs the same model on
 * the same timeline entries to keep the response grounded.
 *
 * Honest disclosure: the narrative is best-effort; the UI labels it as
 * "AI-synthesised from N timeline events and M documents". A new record
 * with no history returns "Not enough data yet."
 */
export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = narrativeRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const entries = perRecordTimeline(
		parsed.data.objectName,
		parsed.data.recordId,
	);
	if (entries.length === 0) {
		return Response.json({
			ok: true,
			narrative: "Not enough data yet.",
			entryCount: 0,
		});
	}

	const entriesForModel = entries
		.map(
			(e) =>
				`[${new Date(e.occurredAt).toISOString().slice(0, 10)}] (${e.kind}) ${e.title}: ${e.body}`,
		)
		.join("\n");

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const send = (event: object): void => {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
				);
			};
			try {
				send({ type: "start", entryCount: entries.length });
				const prompt = parsed.data.question?.trim();
				const result = streamText({
					model: openai("gpt-4o-mini"),
					system:
						"You synthesise a chronological narrative grouped by quarter from CRM timeline entries. Cite each fact by its source date and kind. Be concise (max 3 sentences per quarter).",
					messages: [
						{
							role: "user",
							content: prompt
								? `Timeline entries (${entries.length}):\n${entriesForModel}\n\nQuestion: ${prompt}`
								: `Timeline entries (${entries.length}):\n${entriesForModel}\n\nSynthesise the chronological narrative.`,
						},
					],
					abortSignal: request.signal,
				});
				for await (const part of result.fullStream) {
					if (part.type === "text-delta") {
						send({ type: "delta", text: part.text });
					}
				}
				send({ type: "done" });
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
