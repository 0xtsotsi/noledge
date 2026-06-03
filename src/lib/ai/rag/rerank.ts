import type { RetrievedChunk } from "./retrieve";

/**
 * A reranker reorders (and may trim) retrieved chunks for a query, e.g. with a
 * cross-encoder or a hosted relevance API. It runs after fusion + MMR as the
 * final ordering pass in {@link retrieveChunks}.
 *
 * Implementations must honor `signal` for cancellation and should return the
 * input unchanged on failure rather than throwing, so retrieval stays resilient.
 */
export type Reranker = (
	query: string,
	chunks: RetrievedChunk[],
	signal?: AbortSignal,
) => Promise<RetrievedChunk[]>;

/**
 * Default reranker: returns chunks untouched. The cross-encoder seam is wired but
 * inert — no network dependency is added. A real implementation would slot in
 * here, e.g.:
 *
 * ```ts
 * export const cohereReranker: Reranker = async (query, chunks, signal) => {
 *   const ranked = await cohere.rerank({ query, documents: chunks.map(c => c.content), signal });
 *   return ranked.results.map((r) => chunks[r.index]);
 * };
 * ```
 */
export const identityReranker: Reranker = async (_query, chunks) => chunks;
