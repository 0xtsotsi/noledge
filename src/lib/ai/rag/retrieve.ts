import type { Database } from "better-sqlite3";
import { getDatabase } from "@/lib/ai/db/client";
import {
	blobToVector,
	embedTexts,
	toVectorBlob,
} from "@/lib/ai/embeddings/embed";
import type { Embedder } from "./ingest";
import { keywordSearch } from "./keyword";
import { mmrRerank } from "./mmr";
import { getConfiguredReranker, type Reranker } from "./rerank";

export type RetrievedChunk = {
	chunkId: string;
	documentId: string;
	documentTitle: string;
	content: string;
	/** Best cosine distance from the vector arm (0 = identical). Infinity if the
	 * chunk surfaced only via the keyword arm. */
	distance: number;
	/** Fused RRF relevance score normalized to `[0, 1]` (higher = better). */
	score: number;
	/** Char offset of the chunk's start in the source document, if recorded. */
	start?: number;
	/** Char offset of the chunk's end in the source document, if recorded. */
	end?: number;
	/** When this document was ingested into the knowledge base. */
	documentCreatedAt: number;
	/** Publication timestamp from the upstream source, when available. */
	documentPublishedAt?: number;
	/** Date used for filtering/sorting semantics: publishedAt when known, else createdAt. */
	documentDate: number;
};

export type RetrieveResult =
	| { ok: true; chunks: RetrievedChunk[] }
	| { ok: false; error: string };

export type RetrieveOptions = {
	db?: Database;
	embedder?: Embedder;
	topK?: number;
	/**
	 * Minimum cosine similarity (`[0, 1]`) the vector arm must report for a
	 * candidate that has no keyword hit. Keyword-arm hits are never dropped by
	 * this threshold — a unique token match is relevant regardless of its
	 * embedding distance. Defaults to a permissive 0.3.
	 */
	minScore?: number;
	/**
	 * Back-compat: maximum cosine distance for the vector arm. When provided it
	 * overrides `minScore` with `1 - maxDistance` so existing distance-based
	 * callers keep their behavior.
	 */
	maxDistance?: number;
	/** RRF weight of the semantic (vector) arm before normalization. Default 0.7. */
	vectorWeight?: number;
	/** RRF weight of the keyword (FTS5) arm before normalization. Default 0.3. */
	textWeight?: number;
	/** Run the FTS5 keyword arm and fuse it with vectors. Default true. */
	hybrid?: boolean;
	/** Apply MMR diversity reranking before the final top-k slice. Default true. */
	mmr?: boolean;
	/** Final reordering pass. Defaults to a no-op identity reranker. */
	reranker?: Reranker;
	/** Inclusive lower bound over published_at when known, otherwise created_at. */
	dateFrom?: number;
	/** Inclusive upper bound over published_at when known, otherwise created_at. */
	dateTo?: number;
	signal?: AbortSignal;
};

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.3;
/** Candidate pool size handed to a real reranker before MMR/top-k slicing. */
const RERANK_POOL_SIZE = 30;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_TEXT_WEIGHT = 0.3;
/** Standard reciprocal-rank-fusion constant (Cormack et al.; used by LangChain). */
const RRF_K = 60;

function isMissingEmbeddingConfiguration(error: string): boolean {
	return error.includes("An OpenAI API key is required for embeddings");
}

type VectorRow = {
	chunk_id: string;
	document_id: string;
	document_title: string;
	content: string;
	distance: number;
	start: number | null;
	end: number | null;
	created_at: number;
	published_at: number | null;
	document_date: number;
};

type ChunkRow = {
	id: string;
	document_id: string;
	document_title: string;
	content: string;
	start: number | null;
	end: number | null;
	created_at: number;
	published_at: number | null;
	document_date: number;
};

type Candidate = {
	chunkId: string;
	documentId: string;
	documentTitle: string;
	content: string;
	distance: number;
	start: number | null;
	end: number | null;
	createdAt: number;
	publishedAt: number | null;
	documentDate: number;
	/** Cosine similarity from the vector arm; 0 when keyword-only. */
	vScore: number;
	/** 0-based rank in the vector arm's ordering, or null if absent. */
	vRank: number | null;
	/** 0-based rank in the keyword arm's ordering, or null if absent. */
	tRank: number | null;
};

function clamp01(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/** Candidate overfetch per arm so filtering/MMR never under-fills `topK`. */
function candidateCount(topK: number): number {
	return Math.max(topK * 3, topK + 8);
}

function buildDateWhere(options: RetrieveOptions): {
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
 * Retrieve the top-k most relevant chunks for a query via hybrid keyword+vector
 * retrieval: overfetch candidates from each arm, fuse their rankings with
 * weighted reciprocal-rank fusion (RRF), filter vector-only candidates by
 * `minScore`, diversify with MMR, slice to `topK`, then rerank. Returns a
 * `Result`.
 */
export async function retrieveChunks(
	query: string,
	options: RetrieveOptions = {},
): Promise<RetrieveResult> {
	const db = options.db ?? getDatabase();
	const embedder = options.embedder ?? embedTexts;
	const topK = options.topK ?? DEFAULT_TOP_K;
	const hybrid = options.hybrid ?? true;
	const useMmr = options.mmr ?? true;
	const reranker = options.reranker ?? getConfiguredReranker(options.db);

	const minScore =
		options.maxDistance !== undefined
			? clamp01(1 - options.maxDistance)
			: (options.minScore ?? DEFAULT_MIN_SCORE);

	// Normalize weights so they sum to 1 (mirror the reference clamp logic).
	const rawVectorWeight = Math.max(
		0,
		options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
	);
	const rawTextWeight = Math.max(0, options.textWeight ?? DEFAULT_TEXT_WEIGHT);
	const weightSum = rawVectorWeight + rawTextWeight;
	const vectorWeight = weightSum === 0 ? 1 : rawVectorWeight / weightSum;
	const textWeight = weightSum === 0 ? 0 : rawTextWeight / weightSum;

	const trimmed = query.trim();
	if (trimmed.length === 0) return { ok: true, chunks: [] };

	const embedded = await embedder([trimmed], options.signal);
	const queryVector = embedded.ok ? embedded.embeddings[0] : undefined;
	if (!embedded.ok && !isMissingEmbeddingConfiguration(embedded.error)) {
		return { ok: false, error: embedded.error };
	}

	const candidateK = candidateCount(topK);
	const dateWhere = buildDateWhere(options);

	try {
		const candidates = new Map<string, Candidate>();

		// Vector arm: KNN overfetch → vScore = clamp01(1 - cosineDistance).
		if (queryVector) {
			const vectorRows = db
				.prepare(
					`SELECT
						v.chunk_id    AS chunk_id,
						c.document_id AS document_id,
						d.title       AS document_title,
						c.content                         AS content,
						v.distance                        AS distance,
						c.start                           AS start,
						c.end                             AS end,
						d.created_at                      AS created_at,
						d.published_at                    AS published_at,
						COALESCE(d.published_at, d.created_at) AS document_date
					FROM vec_chunks v
					JOIN chunks c ON c.id = v.chunk_id
					JOIN documents d ON d.id = c.document_id
					WHERE v.embedding MATCH ? AND k = ?${dateWhere.clause}
					ORDER BY v.distance`,
				)
				.all(
					toVectorBlob(queryVector),
					candidateK,
					...dateWhere.params,
				) as VectorRow[];

			vectorRows.forEach((row, rank) => {
				candidates.set(row.chunk_id, {
					chunkId: row.chunk_id,
					documentId: row.document_id,
					documentTitle: row.document_title,
					content: row.content,
					distance: row.distance,
					start: row.start,
					end: row.end,
					createdAt: row.created_at,
					publishedAt: row.published_at,
					documentDate: row.document_date,
					vScore: clamp01(1 - row.distance),
					vRank: rank,
					tRank: null,
				});
			});
		}

		// Keyword arm: FTS5 overfetch, best-first → 0-based rank per hit.
		if (hybrid) {
			const hits = keywordSearch(db, trimmed, candidateK, {
				...(options.dateFrom !== undefined
					? { dateFrom: options.dateFrom }
					: {}),
				...(options.dateTo !== undefined ? { dateTo: options.dateTo } : {}),
			});
			if (hits.length > 0) {
				const getChunk = db.prepare(
					`SELECT
						c.id          AS id,
						c.document_id AS document_id,
						d.title       AS document_title,
						c.content                         AS content,
						c.start                           AS start,
						c.end                             AS end,
						d.created_at                      AS created_at,
						d.published_at                    AS published_at,
						COALESCE(d.published_at, d.created_at) AS document_date
					FROM chunks c
					JOIN documents d ON d.id = c.document_id
					WHERE c.id = ?${dateWhere.clause}`,
				);

				hits.forEach((hit, rank) => {
					const existing = candidates.get(hit.chunkId);
					if (existing) {
						existing.tRank = rank;
						return;
					}
					const row = getChunk.get(hit.chunkId, ...dateWhere.params) as
						| ChunkRow
						| undefined;
					if (!row) return;
					candidates.set(hit.chunkId, {
						chunkId: row.id,
						documentId: row.document_id,
						documentTitle: row.document_title,
						content: row.content,
						distance: Number.POSITIVE_INFINITY,
						start: row.start,
						end: row.end,
						createdAt: row.created_at,
						publishedAt: row.published_at,
						documentDate: row.document_date,
						vScore: 0,
						vRank: null,
						tRank: rank,
					});
				});
			}
		}

		// Weighted RRF: each arm contributes weight / (RRF_K + rank). Normalized to
		// [0, 1] by the maximum possible fused value (both arms at rank 0), so
		// downstream MMR relevance stays in range.
		const maxFused = (vectorWeight + textWeight) / RRF_K;
		const fused = [...candidates.values()]
			.map((candidate) => {
				const raw =
					(candidate.vRank !== null
						? vectorWeight / (RRF_K + candidate.vRank)
						: 0) +
					(candidate.tRank !== null
						? textWeight / (RRF_K + candidate.tRank)
						: 0);
				return { candidate, score: maxFused === 0 ? 0 : raw / maxFused };
			})
			.sort((a, b) => b.score - a.score);

		// minScore is a cosine-similarity floor on the vector arm only: a candidate
		// with a keyword hit always survives (a unique token match is relevant no
		// matter how far its embedding lands), while vector-only candidates below
		// the floor are clearly-unrelated noise.
		const scored = fused.filter(
			(entry) =>
				entry.candidate.tRank !== null || entry.candidate.vScore >= minScore,
		);

		type ScoredEntry = (typeof scored)[number];

		const toRetrievedChunk = (entry: ScoredEntry): RetrievedChunk => ({
			chunkId: entry.candidate.chunkId,
			documentId: entry.candidate.documentId,
			documentTitle: entry.candidate.documentTitle,
			content: entry.candidate.content,
			distance: entry.candidate.distance,
			score: entry.score,
			...(entry.candidate.start !== null
				? { start: entry.candidate.start }
				: {}),
			...(entry.candidate.end !== null ? { end: entry.candidate.end } : {}),
			documentCreatedAt: entry.candidate.createdAt,
			...(entry.candidate.publishedAt !== null
				? { documentPublishedAt: entry.candidate.publishedAt }
				: {}),
			documentDate: entry.candidate.documentDate,
		});

		// Stored embeddings for the (small) final pool, so MMR can measure
		// candidate-vs-candidate similarity with real cosine instead of Jaccard.
		const fetchPoolEmbeddings = (
			entries: ScoredEntry[],
		): Map<string, Float32Array> => {
			if (entries.length === 0) return new Map();
			const ids = entries.map((entry) => entry.candidate.chunkId);
			const placeholders = ids.map(() => "?").join(", ");
			const rows = db
				.prepare(
					`SELECT chunk_id, embedding FROM vec_chunks WHERE chunk_id IN (${placeholders})`,
				)
				.all(...ids) as { chunk_id: string; embedding: Buffer }[];
			return new Map(
				rows.map((row) => [row.chunk_id, blobToVector(row.embedding)]),
			);
		};

		// Note: after a real reranker ran, `entry.score` is the rerank relevance
		// score — MMR consumes it directly as the relevance term.
		const sliceFinal = (entries: ScoredEntry[]): ScoredEntry[] => {
			if (!useMmr) return entries.slice(0, topK);
			const embeddings = fetchPoolEmbeddings(entries);
			return mmrRerank(
				entries.map((entry) => {
					const embedding = embeddings.get(entry.candidate.chunkId);
					return {
						score: entry.score,
						content: entry.candidate.content,
						...(embedding ? { embedding } : {}),
						entry,
					};
				}),
				{ limit: topK },
			).map((item) => item.entry);
		};

		// When a real reranker is active, rerank the pre-filter fused pool so a
		// strong passage the cosine floor would have dropped can still be promoted
		// by the cross-encoder; the threshold then applies to the rerank score
		// instead. The identity (default) path filters first and MMR/slices the
		// fused order directly.
		if (reranker.kind !== "identity") {
			const pool = fused.slice(0, Math.min(RERANK_POOL_SIZE, fused.length));
			const poolChunks = pool.map(toRetrievedChunk);
			const rerankedPool = await reranker.rerank(
				trimmed,
				poolChunks,
				options.signal,
				candidateK,
			);

			// Map reranked chunks back to scored entries, applying the rerank score.
			const byChunkId = new Map(
				pool.map((entry) => [entry.candidate.chunkId, entry]),
			);
			const rerankedEntries: ScoredEntry[] = [];
			for (const chunk of rerankedPool) {
				const entry = byChunkId.get(chunk.chunkId);
				if (!entry) continue;
				rerankedEntries.push({
					candidate: entry.candidate,
					score: chunk.score,
				});
			}

			const selected = sliceFinal(
				rerankedEntries.filter((entry) => entry.score >= minScore),
			);
			return { ok: true, chunks: selected.map(toRetrievedChunk) };
		}

		const selected = sliceFinal(scored);
		return { ok: true, chunks: selected.map(toRetrievedChunk) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Retrieval failed.",
		};
	}
}
