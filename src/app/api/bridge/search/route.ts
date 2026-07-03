import { retrieveChunks } from "@/lib/ai/rag/retrieve";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import {
	errorMessage,
	invalidJsonResponse,
	validationErrorResponse,
} from "@/lib/bridge/route-helpers";
import {
	type BridgeSource,
	bridgeSearchRequestSchema,
	parseIsoDate,
} from "@/lib/bridge/schemas";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return invalidJsonResponse();
	}

	const parsed = bridgeSearchRequestSchema.safeParse(raw);
	if (!parsed.success) return validationErrorResponse(parsed.error);

	try {
		const result = await retrieveChunks(parsed.data.query, {
			topK: parsed.data.topK,
			signal: request.signal,
			dateFrom: parseIsoDate(parsed.data.dateFrom),
			dateTo: parseIsoDate(parsed.data.dateTo),
		});

		if (!result.ok) {
			return Response.json({ ok: false, error: result.error, sources: [] });
		}

		const sources: BridgeSource[] = result.chunks.map((chunk) => ({
			id: chunk.chunkId,
			title: chunk.documentTitle,
			content: chunk.content,
			score: chunk.score,
		}));

		return Response.json({ ok: true, sources });
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: errorMessage(error, "Noledge bridge search failed."),
				sources: [],
			},
			{ status: 500 },
		);
	}
}
