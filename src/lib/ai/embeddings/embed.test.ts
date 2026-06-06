import { cosineSimilarity } from "ai";
import { describe, expect, it } from "vitest";
import { embedTexts, planEmbedBatches } from "./embed";

const hasKey = Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!hasKey)("embedTexts (network)", () => {
	it("returns 1536-dim vectors and ranks similar texts closer", async () => {
		const result = await embedTexts([
			"The cat sat on the warm windowsill.",
			"A feline rested by the sunny window.",
			"Quarterly revenue increased due to strong sales.",
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [a, b, c] = result.embeddings;
		expect(a).toBeDefined();
		expect(a?.length).toBe(1536);
		if (!a || !b || !c) return;

		const similar = cosineSimilarity(a, b);
		const dissimilar = cosineSimilarity(a, c);
		expect(similar).toBeGreaterThan(dissimilar);
	});
});

describe("planEmbedBatches", () => {
	it("keeps a small input list in a single batch", () => {
		const batches = planEmbedBatches(["a", "b", "c"]);
		expect(batches).toEqual([["a", "b", "c"]]);
	});

	it("splits when the input-count cap is exceeded, preserving order", () => {
		const values = Array.from({ length: 5 }, (_, i) => `v${i}`);
		const batches = planEmbedBatches(values, 2, 1_000_000);
		expect(batches).toEqual([["v0", "v1"], ["v2", "v3"], ["v4"]]);
		expect(batches.flat()).toEqual(values);
	});

	it("splits when the token budget would be exceeded", () => {
		// Each value ~25 tokens (100 chars); a 60-token budget fits 2 per batch.
		const values = Array.from({ length: 5 }, () => "x".repeat(100));
		const batches = planEmbedBatches(values, 2048, 60);
		expect(batches).toHaveLength(3);
		expect(batches.flat()).toHaveLength(5);
		for (const batch of batches) {
			const tokens = batch.reduce((s, v) => s + Math.ceil(v.length / 4), 0);
			// Each batch holds at most the 2 values that fit under the 60-token cap.
			expect(tokens).toBeLessThanOrEqual(60);
		}
	});

	it("gives an oversized single value its own batch rather than dropping it", () => {
		const values = ["small", "y".repeat(4000), "small"];
		const batches = planEmbedBatches(values, 2048, 100);
		expect(batches.flat()).toEqual(values);
		expect(batches.some((b) => b.length === 1 && b[0]?.length === 4000)).toBe(
			true,
		);
	});

	it("returns no batches for an empty input", () => {
		expect(planEmbedBatches([])).toEqual([]);
	});
});

describe("embedTexts (no values)", () => {
	it("returns an empty result without calling the network", async () => {
		const result = await embedTexts([]);
		expect(result).toEqual({ ok: true, embeddings: [] });
	});
});
