import { describe, expect, it } from "vitest";
import { chunkText, chunkTextWithSpans } from "./chunk";

describe("chunkText", () => {
	it("returns no chunks for whitespace-only input", () => {
		expect(chunkText("   \n\t  ")).toEqual([]);
	});

	it("returns a single chunk when text fits", () => {
		expect(chunkText("short text", { size: 100 })).toEqual(["short text"]);
	});

	it("produces deterministic overlapping chunks", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const chunks = chunkText(text, { size: 10, overlap: 4 });

		// step = 6 → starts at 0, 6, 12, 18 (last slice reaches the end, loop stops)
		expect(chunks).toEqual([
			"abcdefghij",
			"ghijklmnop",
			"mnopqrstuv",
			"stuvwxyz",
		]);
		// stable on repeat
		expect(chunkText(text, { size: 10, overlap: 4 })).toEqual(chunks);
	});

	it("clamps overlap below size to guarantee progress", () => {
		const chunks = chunkText("abcdefghij", { size: 4, overlap: 10 });
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((c) => c.length <= 4)).toBe(true);
	});

	it("splits on paragraph boundaries, not mid-word", () => {
		const first = "First paragraph about cats and their habits.";
		const second = "Second paragraph about dogs and their walks.";
		const chunks = chunkText(`${first}\n\n${second}`, {
			size: 50,
			overlap: 0,
		});
		expect(chunks).toEqual([first, second]);
	});

	it("keeps words intact when splitting a long line", () => {
		const text = "alpha bravo charlie delta echo foxtrot golf hotel india";
		const chunks = chunkText(text, { size: 20, overlap: 0 });
		// No chunk should start or end by slicing through a word.
		for (const chunk of chunks) {
			expect(text).toContain(chunk);
			expect(chunk).toBe(chunk.trim());
		}
		expect(chunks.join(" ")).toContain("foxtrot");
	});

	it("measures size in tokens (~len/4) under unit:'token'", () => {
		// 80-char line; ~20 tokens. size:5 tokens (~20 chars) forces ~4 chunks.
		const text =
			"alpha bravo charlie delta echo foxtrot golf hotel india juliet";
		const tokenChunks = chunkText(text, { unit: "token", size: 5, overlap: 0 });
		expect(tokenChunks.length).toBeGreaterThan(1);
		// Each chunk should be roughly within the token budget (5 tokens ≈ 20 chars).
		for (const chunk of tokenChunks) {
			expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(6);
		}
	});
});

describe("chunkTextWithSpans", () => {
	it("offsets reconstruct each chunk from the normalized text (char mode)", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const spans = chunkTextWithSpans(text, { size: 10, overlap: 4 });
		expect(spans.length).toBeGreaterThan(1);
		for (const span of spans) {
			expect(text.slice(span.start, span.end)).toBe(span.content);
		}
	});

	it("returns a single full-text span when text fits", () => {
		const spans = chunkTextWithSpans("short text", { size: 100 });
		expect(spans).toEqual([{ content: "short text", start: 0, end: 10 }]);
	});

	it("returns no spans for whitespace-only input", () => {
		expect(chunkTextWithSpans("   \n\t  ")).toEqual([]);
	});
});
