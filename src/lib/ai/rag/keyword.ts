import type { Database } from "better-sqlite3";

/** One FTS5 keyword hit: the chunk's UUID, its rowid, and its raw bm25 rank. */
export type KeywordHit = {
	chunkId: string;
	rowid: number;
	rank: number;
};

type KeywordRow = {
	chunk_id: string;
	rowid: number;
	rank: number;
};

export type KeywordSearchOptions = {
	/** Inclusive lower bound over published_at when known, otherwise created_at. */
	dateFrom?: number;
	/** Inclusive upper bound over published_at when known, otherwise created_at. */
	dateTo?: number;
};

/**
 * Turn a free-text query into a safe FTS5 MATCH expression. Each whitespace token
 * is stripped of FTS syntax characters and wrapped in double quotes (a phrase),
 * then OR-joined. Quoting neutralizes operators (`AND`, `*`, `:`, `-`, `(`) that
 * would otherwise be interpreted as FTS5 syntax and throw.
 */
function sanitizeQuery(query: string): string {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.map((token) => token.replace(/["]/g, "").replace(/[^\p{L}\p{N}]/gu, ""))
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return "";
	return tokens.map((token) => `"${token}"`).join(" OR ");
}

/** True if the FTS5 keyword index exists in this database. */
function ftsAvailable(db: Database): boolean {
	const row = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'",
		)
		.get();
	return row !== undefined;
}

function buildDateWhere(options: KeywordSearchOptions): {
	clause: string;
	params: number[];
} {
	const filters: string[] = [];
	const params: number[] = [];
	if (options.dateFrom !== undefined) {
		filters.push("COALESCE(d.published_at, d.created_at) >= ?");
		params.push(options.dateFrom);
	}
	if (options.dateTo !== undefined) {
		filters.push("COALESCE(d.published_at, d.created_at) <= ?");
		params.push(options.dateTo);
	}
	return {
		clause: filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "",
		params,
	};
}

/**
 * Keyword-search chunks via the FTS5 index, ordered best-first by bm25 `rank`
 * (more negative = better). Returns up to `limit` hits.
 *
 * Degrades gracefully to `[]` when the FTS table is missing (vector-only build),
 * the query sanitizes to empty, or the MATCH expression errors — so the caller
 * can always fall back to the vector arm.
 */
export function keywordSearch(
	db: Database,
	query: string,
	limit: number,
	options: KeywordSearchOptions = {},
): KeywordHit[] {
	if (limit <= 0) return [];
	if (!ftsAvailable(db)) return [];

	const match = sanitizeQuery(query);
	if (match === "") return [];

	try {
		const dateWhere = buildDateWhere(options);
		const rows = db
			.prepare(
				`SELECT
					c.id    AS chunk_id,
					c.rowid AS rowid,
					f.rank  AS rank
				FROM chunks_fts f
				JOIN chunks c ON c.rowid = f.rowid
				JOIN documents d ON d.id = c.document_id
				WHERE chunks_fts MATCH ?${dateWhere.clause}
				ORDER BY f.rank
				LIMIT ?`,
			)
			.all(match, ...dateWhere.params, limit) as KeywordRow[];

		return rows.map((row) => ({
			chunkId: row.chunk_id,
			rowid: row.rowid,
			rank: row.rank,
		}));
	} catch {
		// Malformed MATCH or FTS runtime error — fall back to vector-only.
		return [];
	}
}
