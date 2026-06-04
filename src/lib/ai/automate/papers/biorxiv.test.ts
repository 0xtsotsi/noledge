import { describe, expect, it } from "vitest";
import { parseBiorxiv } from "./biorxiv";

const BIORXIV_SAMPLE = JSON.stringify({
	collection: [
		{
			doi: "10.1101/2026.05.25.727613",
			title: "Heritability of reinforcement learning parameters",
			abstract: "Impaired learning that novel stimuli are safe.",
			date: "2026-05-28",
			version: "1",
			category: "genetics",
		},
		{
			doi: "10.1101/2026.05.20.111111",
			title: "A neuroscience preprint",
			abstract: "Neural dynamics under uncertainty.",
			date: "2026-05-30",
			version: "2",
			category: "neuroscience",
		},
		{
			doi: "10.1101/2026.05.25.727613",
			title: "Heritability of reinforcement learning parameters",
			abstract: "Older version of the same preprint.",
			date: "2026-05-26",
			version: "0",
			category: "genetics",
		},
	],
});

describe("parseBiorxiv", () => {
	it("dedupes by DOI, sorts newest first, and builds the landing URL", () => {
		const items = parseBiorxiv(BIORXIV_SAMPLE, "biorxiv", "", 10);
		expect(items).toHaveLength(2);

		// Newest (2026-05-30) comes first.
		expect(items[0]?.title).toBe("A neuroscience preprint");
		expect(items[0]?.url).toBe(
			"https://www.biorxiv.org/content/10.1101/2026.05.20.111111v2",
		);
		expect(items[1]?.externalId).toBe("10.1101/2026.05.25.727613");
	});

	it("filters by category case-insensitively", () => {
		const items = parseBiorxiv(BIORXIV_SAMPLE, "biorxiv", "Neuroscience", 10);
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("A neuroscience preprint");
	});

	it("uses the medrxiv host for the medrxiv server", () => {
		const items = parseBiorxiv(BIORXIV_SAMPLE, "medrxiv", "neuroscience", 10);
		expect(items[0]?.url).toContain("https://www.medrxiv.org/content/");
	});

	it("returns an empty list for malformed JSON", () => {
		expect(parseBiorxiv("nope", "biorxiv", "", 10)).toEqual([]);
	});
});
