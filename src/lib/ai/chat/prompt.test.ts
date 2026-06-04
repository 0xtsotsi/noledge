import { describe, expect, it } from "vitest";
import type { RetrievedChunk } from "@/lib/ai/rag/retrieve";
import { buildToolSystemPrompt, toSources } from "./prompt";

const chunks: RetrievedChunk[] = [
	{
		chunkId: "c1",
		documentId: "d1",
		documentTitle: "Cat Facts",
		content: "Cats sleep a lot.",
		distance: 0.1,
		score: 0.9,
		documentCreatedAt: 1,
		documentDate: 1,
	},
	{
		chunkId: "c2",
		documentId: "d1",
		documentTitle: "Cat Facts",
		content: "Cats purr when content.",
		distance: 0.2,
		score: 0.8,
		documentCreatedAt: 1,
		documentDate: 1,
	},
];

describe("buildToolSystemPrompt", () => {
	it("never injects retrieved context", () => {
		const prompt = buildToolSystemPrompt();
		expect(prompt.map((message) => message.content).join("\n")).not.toContain(
			"<context>",
		);
	});

	it("separates cacheable instructions from dynamic runtime context", () => {
		const prompt = buildToolSystemPrompt(
			new Date("2026-06-05T00:00:00.000Z"),
			"Europe/London",
		);
		expect(prompt).toHaveLength(2);
		expect(prompt[0]?.content).toContain("searchKnowledge");
		expect(prompt[0]?.content).toContain("Memory and context");
		expect(prompt[0]?.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
		expect(prompt[1]?.content).toContain("Runtime context (not cached)");
		expect(prompt[1]?.content).toContain("2026-06-05T00:00:00.000Z");
		expect(prompt[1]?.content).toContain("Europe/London");
		expect(prompt[1]?.providerOptions).toBeUndefined();
	});
});

describe("toSources", () => {
	it("deduplicates by document id", () => {
		const sources = toSources(chunks);
		expect(sources).toHaveLength(1);
		expect(sources[0]?.title).toBe("Cat Facts");
	});
});
