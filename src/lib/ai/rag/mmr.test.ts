import { describe, expect, it } from "vitest";
import { computeMmr, jaccard, mmrRerank, tokenize } from "./mmr";

describe("tokenize + jaccard", () => {
	it("lowercases and splits into word/number tokens", () => {
		expect([...tokenize("The Cat-9 sat!")].sort()).toEqual([
			"9",
			"cat",
			"sat",
			"the",
		]);
	});

	it("computes set Jaccard similarity", () => {
		const a = tokenize("alpha beta gamma");
		const b = tokenize("beta gamma delta");
		// intersection {beta, gamma} = 2, union {alpha,beta,gamma,delta} = 4
		expect(jaccard(a, b)).toBe(0.5);
	});

	it("returns 0 for two empty sets", () => {
		expect(jaccard(new Set(), new Set())).toBe(0);
	});
});

describe("computeMmr", () => {
	it("equals relevance when lambda is 1", () => {
		expect(computeMmr(0.8, 0.9, 1)).toBe(0.8);
	});

	it("penalizes similarity to selected items", () => {
		expect(computeMmr(0.8, 1, 0.5)).toBeCloseTo(0.5 * 0.8 - 0.5 * 1);
	});
});

describe("mmrRerank", () => {
	it("prefers a diverse second item over a near-duplicate of the first", () => {
		const items = [
			{ score: 1.0, content: "the quick brown fox jumps" },
			{ score: 0.95, content: "the quick brown fox jumps over" }, // near-dup of #1
			{ score: 0.9, content: "lazy dogs sleep all afternoon" }, // diverse
		];
		const out = mmrRerank(items, { lambda: 0.5, limit: 2 });
		expect(out[0]?.content).toBe("the quick brown fox jumps");
		expect(out[1]?.content).toBe("lazy dogs sleep all afternoon");
	});

	it("reduces to pure relevance order when lambda is 1", () => {
		const items = [
			{ score: 0.3, content: "a a a" },
			{ score: 0.9, content: "a a b" },
			{ score: 0.6, content: "a a c" },
		];
		const out = mmrRerank(items, { lambda: 1 });
		expect(out.map((item) => item.score)).toEqual([0.9, 0.6, 0.3]);
	});

	it("uses embedding cosine to demote a paraphrase the tokens cannot catch", () => {
		// #1 and #2 are paraphrases: near-identical embeddings but almost no
		// token overlap, so only the cosine path can spot the duplicate.
		const items = [
			{
				score: 1.0,
				content: "the cat sat on the mat",
				embedding: new Float32Array([1, 0.02, 0]),
			},
			{
				score: 0.95,
				content: "a feline rested upon its rug",
				embedding: new Float32Array([1, 0, 0.02]),
			},
			{
				score: 0.9,
				content: "quarterly finance report shows revenue",
				embedding: new Float32Array([0, 1, 0]),
			},
		];
		const out = mmrRerank(items, { lambda: 0.5, limit: 2 });
		expect(out[0]?.content).toBe("the cat sat on the mat");
		expect(out[1]?.content).toBe("quarterly finance report shows revenue");
	});

	it("falls back to Jaccard when an item has no embedding", () => {
		const items = [
			{
				score: 1.0,
				content: "the quick brown fox jumps",
				embedding: new Float32Array([1, 0]),
			},
			{ score: 0.95, content: "the quick brown fox jumps over" }, // near-dup, no embedding
			{ score: 0.9, content: "lazy dogs sleep all afternoon" },
		];
		const out = mmrRerank(items, { lambda: 0.5, limit: 2 });
		expect(out[0]?.content).toBe("the quick brown fox jumps");
		expect(out[1]?.content).toBe("lazy dogs sleep all afternoon");
	});

	it("returns empty for empty input or non-positive limit", () => {
		expect(mmrRerank([], {})).toEqual([]);
		expect(mmrRerank([{ score: 1, content: "x" }], { limit: 0 })).toEqual([]);
	});
});
