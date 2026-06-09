import { createCohere } from "@ai-sdk/cohere";
import { rerank } from "ai";
import type { Database } from "better-sqlite3";
import { getAppSetting } from "@/lib/ai/settings";
import type { RetrievedChunk } from "./retrieve";

/**
 * A reranker reorders (and may trim) retrieved chunks for a query, e.g. with a
 * cross-encoder or a hosted relevance API. It runs over the candidate pool in
 * {@link retrieveChunks} before the final MMR/top-k slice. The `kind`
 * discriminant lets retrieval detect the no-op identity reranker without
 * relying on reference equality.
 *
 * Implementations must honor `signal` for cancellation and should return the
 * input unchanged on failure rather than throwing, so retrieval stays resilient.
 */
export type Reranker = {
	kind: "identity" | "cohere";
	rerank(
		query: string,
		chunks: RetrievedChunk[],
		signal?: AbortSignal,
		topN?: number,
	): Promise<RetrievedChunk[]>;
};

/** Default Cohere cross-encoder model used when none is configured. */
export const DEFAULT_RERANK_MODEL = "rerank-v3.5";

/**
 * Default reranker: returns chunks untouched. Used when reranking is disabled,
 * unconfigured, or as a graceful fallback on any provider error.
 */
export const identityReranker: Reranker = {
	kind: "identity",
	rerank: async (_query, chunks) => chunks,
};

/**
 * Build a Cohere cross-encoder reranker. It reorders the input chunks by the
 * provider's relevance score (copying that score onto each returned chunk so
 * downstream MMR uses real relevance values) and honors `signal`.
 *
 * Per the {@link Reranker} contract, it returns the input chunks unchanged on
 * any error so retrieval never fails because of the reranker.
 */
export function cohereReranker(opts: {
	apiKey: string;
	model?: string;
}): Reranker {
	const cohere = createCohere({ apiKey: opts.apiKey });
	const modelId = opts.model ?? DEFAULT_RERANK_MODEL;
	return {
		kind: "cohere",
		rerank: async (query, chunks, signal, topN) => {
			if (chunks.length === 0) return chunks;
			try {
				const { ranking } = await rerank({
					model: cohere.reranking(modelId),
					documents: chunks.map((chunk) => chunk.content),
					query,
					...(topN !== undefined ? { topN } : {}),
					...(signal ? { abortSignal: signal } : {}),
				});
				const reordered: RetrievedChunk[] = [];
				for (const item of ranking) {
					const chunk = chunks[item.originalIndex];
					if (!chunk) continue;
					reordered.push({ ...chunk, score: item.score });
				}
				return reordered.length > 0 ? reordered : chunks;
			} catch {
				return chunks;
			}
		},
	};
}

/**
 * Resolve the reranker from persisted settings: returns a {@link cohereReranker}
 * when reranking is enabled and an API key is stored, otherwise the
 * {@link identityReranker} (today's no-op behavior).
 */
export function getConfiguredReranker(db?: Database): Reranker {
	const enabled = getAppSetting("rag.rerankEnabled", db);
	if (enabled !== "true") return identityReranker;
	const apiKey = getAppSetting("rag.rerankApiKey", db);
	if (!apiKey) return identityReranker;
	const model = getAppSetting("rag.rerankModel", db);
	return cohereReranker({ apiKey, ...(model ? { model } : {}) });
}
