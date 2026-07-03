import { NextResponse } from "next/server";

import { retrieveChunks } from "@/lib/ai/rag/retrieve";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import {
	errorMessage,
	invalidJsonResponse,
	validationErrorResponse,
} from "@/lib/bridge/route-helpers";
import {
	type BridgeAskSource,
	bridgeAskRequestSchema,
} from "@/lib/bridge/schemas";

export const runtime = "nodejs";

const SNIPPET_MAX_CHARS = 240;
const TOKEN_PACE_MS = 25;

function trimSnippet(value: string, max: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function buildAnswer(
	prompt: string,
	chunks: { documentTitle: string; content: string; score: number }[],
): string {
	if (chunks.length === 0) {
		return `No matching Noledge documents were found for: "${prompt}".`;
	}
	const lead = `Top ${chunks.length} matching document${chunks.length === 1 ? "" : "s"} for "${prompt}":`;
	const lines = chunks.map(
		(chunk, index) =>
			`${index + 1}. ${chunk.documentTitle} — ${trimSnippet(chunk.content, SNIPPET_MAX_CHARS)}`,
	);
	return [lead, ...lines].join("\n\n");
}

function buildSources(
	chunks: { documentTitle: string; score: number }[],
	crmContext: { objectName: string; recordId: string } | undefined,
): BridgeAskSource[] {
	return chunks.map((chunk) => ({
		title: chunk.documentTitle,
		sourceUrl: crmContext
			? `http://localhost:2020/object/${crmContext.objectName}/${crmContext.recordId}`
			: undefined,
		score: Number(chunk.score.toFixed(4)),
	}));
}

export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return invalidJsonResponse();
	}

	const parsed = bridgeAskRequestSchema.safeParse(raw);
	if (!parsed.success) return validationErrorResponse(parsed.error);

	const { prompt, crmContext, topK } = parsed.data;
	const query = crmContext?.title ? `${crmContext.title}\n\n${prompt}` : prompt;

	let retrieval: Awaited<ReturnType<typeof retrieveChunks>>;
	try {
		retrieval = await retrieveChunks(query, { topK, signal: request.signal });
	} catch (error) {
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`event: error\ndata: ${JSON.stringify({ message: errorMessage(error, "Retrieval failed.") })}\n\n`,
					),
				);
				controller.close();
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				"x-accel-buffering": "no",
			},
		});
	}

	if (!retrieval.ok) {
		const body = {
			ok: false as const,
			error: retrieval.error,
			sources: [] as [],
		};
		return NextResponse.json(body, { status: 422 });
	}

	const answer = buildAnswer(
		prompt,
		retrieval.chunks.map((chunk) => ({
			documentTitle: chunk.documentTitle,
			content: chunk.content,
			score: chunk.score,
		})),
	);
	const sources = buildSources(
		retrieval.chunks.map((chunk) => ({
			documentTitle: chunk.documentTitle,
			score: chunk.score,
		})),
		crmContext,
	);

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				controller.enqueue(
					encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
				);
			};
			try {
				// Emit one token per sentence/paragraph chunk
				const segments = answer.split(/(\n\n)/);
				for (const segment of segments) {
					if (segment.length === 0) continue;
					send("token", { text: segment });
					if (segment.includes("\n\n")) {
						await new Promise((r) => setTimeout(r, TOKEN_PACE_MS * 2));
					} else {
						await new Promise((r) => setTimeout(r, TOKEN_PACE_MS));
					}
				}
				send("sources", { sources });
				send("done", { ok: true });
			} catch (error) {
				send("error", { message: errorMessage(error, "Stream failed.") });
			} finally {
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
		},
	});
}
