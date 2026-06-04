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
	chunks: number;
};

type DocumentTypeFilter =
	| "all"
	| "article"
	| "video"
	| "paper"
	| "pdf"
	| "image"
	| "spreadsheet"
	| "text";

type DocumentSortKey = "name" | "type" | "chunks" | "size" | "added";
type DocumentSortDirection = "asc" | "desc";

type FilterClause = {
	sql: string;
	params: string[];
};

type DocumentTypeCounts = Record<DocumentTypeFilter, number>;

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
const DOCUMENT_TYPE_FILTER_VALUES = [
	"all",
	"article",
	"video",
	"paper",
	"pdf",
	"image",
	"spreadsheet",
	"text",
] satisfies DocumentTypeFilter[];
const DOCUMENT_TYPE_FILTERS = new Set<DocumentTypeFilter>(
	DOCUMENT_TYPE_FILTER_VALUES,
);
const DOCUMENT_SORT_KEYS = new Set<DocumentSortKey>([
	"name",
	"type",
	"chunks",
	"size",
	"added",
]);
const DOCUMENT_SORT_DIRECTIONS = new Set<DocumentSortDirection>([
	"asc",
	"desc",
]);

const YOUTUBE_URL_SQL =
	"LOWER(COALESCE(d.source_url, '')) GLOB '*youtube.com*' OR LOWER(COALESCE(d.source_url, '')) GLOB '*youtu.be*'";
const PAPER_URL_SQL =
	"LOWER(COALESCE(d.source_url, '')) GLOB '*arxiv.org*' OR LOWER(COALESCE(d.source_url, '')) GLOB '*openalex.org*' OR LOWER(COALESCE(d.source_url, '')) GLOB '*doi.org*' OR LOWER(COALESCE(d.source_url, '')) GLOB '*pubmed.ncbi.nlm.nih.gov*' OR LOWER(COALESCE(d.source_url, '')) GLOB '*biorxiv.org*' OR LOWER(COALESCE(d.source_url, '')) GLOB '*medrxiv.org*'";
const SPREADSHEET_SQL =
	"LOWER(d.filename) GLOB '*.xlsx' OR LOWER(d.filename) GLOB '*.ods' OR LOWER(d.filename) GLOB '*.csv'";
const PDF_SQL = "d.mime = 'application/pdf' OR LOWER(d.filename) GLOB '*.pdf'";
const IMAGE_SQL = "d.mime LIKE 'image/%'";

const TYPE_LABEL_SQL = `CASE
	WHEN ${YOUTUBE_URL_SQL} THEN 'Video'
	WHEN ${PAPER_URL_SQL} THEN 'Paper'
	WHEN d.source_id IS NOT NULL THEN 'Article'
	WHEN ${IMAGE_SQL} THEN 'Image'
	WHEN ${SPREADSHEET_SQL} THEN 'Spreadsheet'
	WHEN ${PDF_SQL} THEN 'PDF'
	ELSE 'Text'
END`;

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

function parseDocumentTypeFilter(value: string | null): DocumentTypeFilter {
	if (
		value !== null &&
		DOCUMENT_TYPE_FILTERS.has(value as DocumentTypeFilter)
	) {
		return value as DocumentTypeFilter;
	}
	return "all";
}

function parseDocumentSortKey(value: string | null): DocumentSortKey {
	if (value !== null && DOCUMENT_SORT_KEYS.has(value as DocumentSortKey)) {
		return value as DocumentSortKey;
	}
	return "added";
}

function parseDocumentSortDirection(
	value: string | null,
): DocumentSortDirection {
	if (
		value !== null &&
		DOCUMENT_SORT_DIRECTIONS.has(value as DocumentSortDirection)
	) {
		return value as DocumentSortDirection;
	}
	return "desc";
}

function filterClauseFor(type: DocumentTypeFilter): FilterClause {
	switch (type) {
		case "video":
			return { sql: `WHERE ${YOUTUBE_URL_SQL}`, params: [] };
		case "paper":
			return { sql: `WHERE ${PAPER_URL_SQL}`, params: [] };
		case "article":
			return {
				sql: `WHERE d.source_id IS NOT NULL AND NOT (${YOUTUBE_URL_SQL}) AND NOT (${PAPER_URL_SQL})`,
				params: [],
			};
		case "pdf":
			return { sql: `WHERE d.source_id IS NULL AND (${PDF_SQL})`, params: [] };
		case "image":
			return {
				sql: `WHERE d.source_id IS NULL AND (${IMAGE_SQL})`,
				params: [],
			};
		case "spreadsheet":
			return {
				sql: `WHERE d.source_id IS NULL AND (${SPREADSHEET_SQL})`,
				params: [],
			};
		case "text":
			return {
				sql: `WHERE d.source_id IS NULL AND NOT (${PDF_SQL}) AND NOT (${IMAGE_SQL}) AND NOT (${SPREADSHEET_SQL})`,
				params: [],
			};
		case "all":
			return { sql: "", params: [] };
	}
}

function orderByClauseFor(
	sort: DocumentSortKey,
	direction: DocumentSortDirection,
): string {
	const dir = direction === "asc" ? "ASC" : "DESC";
	switch (sort) {
		case "name":
			return `d.title COLLATE NOCASE ${dir}, d.created_at DESC`;
		case "type":
			return `${TYPE_LABEL_SQL} COLLATE NOCASE ${dir}, d.title COLLATE NOCASE ASC`;
		case "chunks":
			return `COALESCE(cc.chunks, 0) ${dir}, d.created_at DESC`;
		case "size":
			return `d.bytes ${dir}, d.created_at DESC`;
		case "added":
			return `d.created_at ${dir}, d.title COLLATE NOCASE ASC`;
	}
}

function countForFilter(type: DocumentTypeFilter): number {
	const db = getDatabase();
	const filter = filterClauseFor(type);
	return (
		db
			.prepare(`SELECT COUNT(*) AS count FROM documents d ${filter.sql}`)
			.get(...filter.params) as { count: number }
	).count;
}

function documentTypeCounts(): DocumentTypeCounts {
	return Object.fromEntries(
		DOCUMENT_TYPE_FILTER_VALUES.map((filter) => [
			filter,
			countForFilter(filter),
		]),
	) as DocumentTypeCounts;
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
	const type = parseDocumentTypeFilter(params.get("type"));
	const sort = parseDocumentSortKey(params.get("sort"));
	const direction = parseDocumentSortDirection(params.get("direction"));
	const filter = filterClauseFor(type);
	const orderBy = orderByClauseFor(sort, direction);

	const db = getDatabase();
	const total = (
		db
			.prepare(`SELECT COUNT(*) AS count FROM documents d ${filter.sql}`)
			.get(...filter.params) as { count: number }
	).count;
	const rows = db
		.prepare(
			`SELECT d.id, d.title, d.filename, d.mime, d.bytes, d.created_at, d.source_id, d.source_url, COALESCE(cc.chunks, 0) AS chunks
			FROM documents d
			LEFT JOIN (
				SELECT document_id, COUNT(*) AS chunks
				FROM chunks
				GROUP BY document_id
			) cc ON cc.document_id = d.id
			${filter.sql}
			ORDER BY ${orderBy}
			LIMIT ? OFFSET ?`,
		)
		.all(...filter.params, limit, offset) as DocumentRow[];

	const documents = rows.map((row) => ({
		id: row.id,
		title: row.title,
		filename: row.filename,
		mime: row.mime,
		bytes: row.bytes,
		createdAt: row.created_at,
		sourceId: row.source_id,
		sourceUrl: row.source_url,
		chunks: row.chunks,
	}));

	return Response.json({
		documents,
		total,
		counts: documentTypeCounts(),
		limit,
		offset,
		type,
		sort,
		direction,
	});
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
