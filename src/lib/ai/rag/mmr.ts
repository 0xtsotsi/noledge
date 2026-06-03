/**
 * Maximal Marginal Relevance (MMR) reranking. Greedily picks items that balance
 * relevance to the query against novelty versus already-selected items, so the
 * final list is not crowded by near-duplicate chunks.
 *
 * Similarity between candidates uses token Jaccard rather than embeddings, so the
 * pass is cheap, deterministic, and needs no extra query vectors at rerank time.
 */

/** Default relevance/diversity tradeoff: 1 = pure relevance, 0 = pure novelty. */
const DEFAULT_LAMBDA = 0.7;

const TOKEN_PATTERN = /[a-z0-9]+/g;

/** Lowercase word/number tokens of `text` as a set (for Jaccard similarity). */
export function tokenize(text: string): Set<string> {
	const matches = text.toLowerCase().match(TOKEN_PATTERN);
	return new Set(matches ?? []);
}

/** Jaccard similarity `|a ∩ b| / |a ∪ b|` in `[0, 1]`; empty/empty → 0. */
export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection += 1;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** MMR objective for one candidate: `λ·relevance − (1−λ)·maxSimToSelected`. */
export function computeMmr(
	relevance: number,
	maxSim: number,
	lambda: number,
): number {
	return lambda * relevance - (1 - lambda) * maxSim;
}

export type MmrItem = {
	score: number;
	content: string;
};

export type MmrOptions = {
	/** Relevance/diversity tradeoff in `[0, 1]`. Defaults to 0.7. */
	lambda?: number;
	/** Maximum number of items to return. Defaults to all items. */
	limit?: number;
};

/**
 * Rerank `items` by MMR and return them in selection order, truncated to `limit`.
 * Input order is treated as the tie-breaker, so passing items pre-sorted by score
 * keeps results stable. Pure and deterministic.
 */
export function mmrRerank<T extends MmrItem>(
	items: T[],
	options: MmrOptions = {},
): T[] {
	const lambda = options.lambda ?? DEFAULT_LAMBDA;
	const limit = options.limit ?? items.length;
	if (items.length === 0 || limit <= 0) return [];

	const tokens = items.map((item) => tokenize(item.content));
	const remaining = items.map((_, index) => index);
	const selected: number[] = [];

	while (selected.length < limit && remaining.length > 0) {
		let bestPos = 0;
		let bestValue = Number.NEGATIVE_INFINITY;
		for (let pos = 0; pos < remaining.length; pos += 1) {
			const index = remaining[pos];
			if (index === undefined) continue;
			let maxSim = 0;
			for (const chosen of selected) {
				const candidateTokens = tokens[index];
				const chosenTokens = tokens[chosen];
				if (!candidateTokens || !chosenTokens) continue;
				const sim = jaccard(candidateTokens, chosenTokens);
				if (sim > maxSim) maxSim = sim;
			}
			const value = computeMmr(items[index]?.score ?? 0, maxSim, lambda);
			if (value > bestValue) {
				bestValue = value;
				bestPos = pos;
			}
		}
		const chosenIndex = remaining[bestPos];
		if (chosenIndex !== undefined) selected.push(chosenIndex);
		remaining.splice(bestPos, 1);
	}

	return selected
		.map((index) => items[index])
		.filter((item): item is T => !!item);
}
