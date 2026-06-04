import { getDatabase } from "@/lib/ai/db/client";
import { ingestDocument } from "@/lib/ai/rag/ingest";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB per upload.

type DocumentRow = {
	id: string;
	title: string;
	filename: string;
	mime: string;
	bytes: number;
	created_at: number;
	source_id: string | null;
	source_url: string | null;
};

export async function POST(request: Request): Promise<Response> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return Response.json(
			{ error: "Expected multipart/form-data" },
			{ status: 400 },
		);
	}

	const file = form.get("file");
	if (!(file instanceof File)) {
		return Response.json(
			{ error: "Missing `file` in form data" },
			{ status: 400 },
		);
	}

	if (file.size > MAX_BYTES) {
		return Response.json(
			{ error: `File exceeds ${MAX_BYTES} byte limit` },
			{ status: 413 },
		);
	}

	const data = Buffer.from(await file.arrayBuffer());
	const titleField = form.get("title");
	const title = typeof titleField === "string" ? titleField : undefined;

	const result = await ingestDocument(
		{
			data,
			filename: file.name,
			mime: file.type || "application/octet-stream",
			title,
		},
		{ signal: request.signal },
	);

	if (!result.ok) {
		return Response.json({ error: result.error }, { status: 422 });
	}

	return Response.json({
		documentId: result.documentId,
		chunks: result.chunks,
		duplicate: result.duplicate,
	});
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Parse a non-negative integer query param, clamped to [min, max]. */
function parseIntParam(
	value: string | null,
	fallback: number,
	min: number,
	max: number,
): number {
	const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, min), max);
}

export async function GET(request: Request): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const limit = parseIntParam(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = parseIntParam(
		params.get("offset"),
		0,
		0,
		Number.MAX_SAFE_INTEGER,
	);

	const db = getDatabase();
	const total = (
		db.prepare("SELECT COUNT(*) AS count FROM documents").get() as {
			count: number;
		}
	).count;
	const rows = db
		.prepare(
			"SELECT id, title, filename, mime, bytes, created_at, source_id, source_url FROM documents ORDER BY created_at DESC LIMIT ? OFFSET ?",
		)
		.all(limit, offset) as DocumentRow[];

	const documents = rows.map((row) => ({
		id: row.id,
		title: row.title,
		filename: row.filename,
		mime: row.mime,
		bytes: row.bytes,
		createdAt: row.created_at,
		sourceId: row.source_id,
		sourceUrl: row.source_url,
		chunks: (
			db
				.prepare("SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?")
				.get(row.id) as { count: number }
		).count,
	}));

	return Response.json({ documents, total, limit, offset });
}

export async function DELETE(request: Request): Promise<Response> {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) {
		return Response.json(
			{ error: "Missing `id` query param" },
			{ status: 400 },
		);
	}

	const db = getDatabase();
	const remove = db.transaction((documentId: string) => {
		const chunkIds = db
			.prepare("SELECT id FROM chunks WHERE document_id = ?")
			.all(documentId) as { id: string }[];
		const deleteVec = db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
		for (const chunk of chunkIds) deleteVec.run(chunk.id);
		// Deleting from `chunks` fires the chunks_fts delete trigger, which removes
		// the matching FTS rows via the FTS5 'delete' command (required for
		// external-content tables). `chunks` would also cascade via the FK, but we
		// delete explicitly so the trigger runs deterministically here.
		db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
		const info = db
			.prepare("DELETE FROM documents WHERE id = ?")
			.run(documentId);
		return info.changes;
	});

	const changes = remove(id);
	if (changes === 0) {
		return Response.json({ error: "Document not found" }, { status: 404 });
	}

	return Response.json({ deleted: id });
}
