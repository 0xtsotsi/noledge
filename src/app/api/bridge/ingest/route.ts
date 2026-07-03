import { getDatabase } from "@/lib/ai/db/client";
import { ingestText } from "@/lib/ai/rag/ingest";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import {
	invalidJsonResponse,
	validationErrorResponse,
} from "@/lib/bridge/route-helpers";
import { bridgeIngestRequestSchema } from "@/lib/bridge/schemas";

export const runtime = "nodejs";

function lookupExistingDocument(
	sourceId: string,
	externalId: string,
): { id: string; chunks: number } | undefined {
	try {
		const row = getDatabase()
			.prepare(
				"SELECT id FROM documents WHERE source_id = ? AND external_id = ? LIMIT 1",
			)
			.get(sourceId, externalId) as { id: string } | undefined;
		if (!row) return undefined;
		const chunkRow = getDatabase()
			.prepare("SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?")
			.get(row.id) as { count: number };
		return { id: row.id, chunks: chunkRow.count };
	} catch {
		return undefined;
	}
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

	const parsed = bridgeIngestRequestSchema.safeParse(raw);
	if (!parsed.success) return validationErrorResponse(parsed.error);

	const input = parsed.data;
	const publishedAt = input.publishedAt ? Date.parse(input.publishedAt) : null;
	const externalId = `${input.objectName}:${input.recordId}`;

	const result = await ingestText(
		{
			text: input.text,
			title: input.title,
			filename: `${input.objectName}-${input.recordId}.txt`,
			mime: "text/plain",
			bytes: Buffer.byteLength(input.text, "utf8"),
			sourceId: input.source,
			externalId,
			sourceUrl: input.sourceUrl,
			publishedAt: Number.isNaN(publishedAt) ? null : publishedAt,
		},
		{ signal: request.signal },
	);

	if (!result.ok) {
		// `ingestText` catches the SQL UNIQUE failure inside its transaction
		// wrapper and returns it as `ok: false` with the raw SQLite message.
		// Translate that case into a successful no-op so the caller can keep using
		// the same documentId on re-ingest.
		if (/UNIQUE constraint failed/.test(result.error)) {
			const existing = lookupExistingDocument(input.source, externalId);
			return Response.json({
				ok: true,
				documentId: existing?.id ?? null,
				chunks: existing?.chunks ?? 0,
				duplicate: true,
			});
		}
		return Response.json({ ok: false, error: result.error }, { status: 422 });
	}

	return Response.json({
		ok: true,
		documentId: result.documentId,
		chunks: result.chunks,
		duplicate: result.duplicate,
	});
}
