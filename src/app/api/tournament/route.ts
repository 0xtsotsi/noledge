import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

const tournamentRequestSchema = z.object({
	objectName: z.enum(["company", "person", "opportunity"]),
	recordId: z.string().min(1),
});

const SYSTEM_PROMPT = `You are a ${"TBD"} sales-strategy agent analyzing a CRM record.
Use the available context (timeline activities, documents, prior calls) and
state your position on whether the deal is ready to advance, what the
biggest blocker is, and what to do next week. Be concrete and cite your
sources (e.g. "per the Nov 12 transcript").`;

/**
 * POST /api/tournament
 * Body: `{ objectName, recordId }`.
 *
 * Runs the conservative and aggressive agents in parallel and emits an SSE
 * stream. Each event is a JSON object with `agent: "conservative" |
 * "aggressive" | "system"`, a `type` discriminator, and the relevant
 * payload (text-delta, finish, divergence).
 *
 * Honest disclosure: streaming two agents in parallel doubles the LLM cost
 * per tournament vs. the existing sequential flow in
 * `propose-write-tournament.logic-function.ts`. The cost meter tracks it.
 */
export async function POST(request: Request): Promise<Response> {
	const authHeader = request.headers.get("x-noledge-bridge-secret");
	const configured = process.env.NOLEDGE_BRIDGE_SECRET;
	if (!configured || authHeader !== configured) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = tournamentRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const { objectName, recordId } = parsed.data;
	const userPrompt = `Analyse the ${objectName} ${recordId}. What is your position on whether the deal is ready to advance? Cite specific timeline entries and documents.`;

	const conservativeModel = anthropic("claude-fable-5");
	const aggressiveModel = anthropic("claude-fable-5"); // Both same in dev; v2 uses opus

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: object): void => {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
				);
			};
			try {
				send({ agent: "system", type: "start" });

				const conservative = streamText({
					model: conservativeModel,
					system: SYSTEM_PROMPT.replace("TBD", "conservative (cautious)"),
					messages: [{ role: "user", content: userPrompt }],
					abortSignal: request.signal,
				});
				const aggressive = streamText({
					model: aggressiveModel,
					system: SYSTEM_PROMPT.replace("TBD", "aggressive (action-biased)"),
					messages: [{ role: "user", content: userPrompt }],
					abortSignal: request.signal,
				});

				let conservativeText = "";
				let aggressiveText = "";

				// Drain both streams concurrently. Race-free: each iteration
				// only awaits the next chunk from whichever stream produced
				// one first.
				await Promise.all([
					(async (): Promise<void> => {
						for await (const part of conservative.fullStream) {
							if (part.type === "text-delta") {
								conservativeText += part.text;
								send({
									agent: "conservative",
									type: "delta",
									text: part.text,
								});
							} else if (part.type === "finish-step") {
								send({
									agent: "conservative",
									type: "finish-step",
									finishReason: part.finishReason,
								});
							}
						}
						send({
							agent: "conservative",
							type: "done",
							text: conservativeText,
						});
					})(),
					(async (): Promise<void> => {
						for await (const part of aggressive.fullStream) {
							if (part.type === "text-delta") {
								aggressiveText += part.text;
								send({
									agent: "aggressive",
									type: "delta",
									text: part.text,
								});
							} else if (part.type === "finish-step") {
								send({
									agent: "aggressive",
									type: "finish-step",
									finishReason: part.finishReason,
								});
							}
						}
						send({
							agent: "aggressive",
							type: "done",
							text: aggressiveText,
						});
					})(),
				]);

				send({ agent: "system", type: "divergence", note: "See front-end for divergence computation." });
				send({ agent: "system", type: "complete" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				send({ agent: "system", type: "error", message });
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