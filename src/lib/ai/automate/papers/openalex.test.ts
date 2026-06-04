import { describe, expect, it } from "vitest";
import { parseOpenalex, reconstructAbstract } from "./openalex";

describe("reconstructAbstract", () => {
	it("rebuilds prose from an inverted index honoring positions", () => {
		const index = {
			the: [1, 4],
			Diffusion: [0],
			model: [2],
			beats: [3],
			rest: [5],
		};
		expect(reconstructAbstract(index)).toBe(
			"Diffusion the model beats the rest",
		);
	});

	it("returns an empty string for null or empty input", () => {
		expect(reconstructAbstract(null)).toBe("");
		expect(reconstructAbstract(undefined)).toBe("");
		expect(reconstructAbstract({})).toBe("");
	});
});

const OPENALEX_SAMPLE = JSON.stringify({
	results: [
		{
			id: "https://openalex.org/W4312933868",
			title: "High-Resolution Image Synthesis with Latent Diffusion Models",
			publication_date: "2022-06-01",
			abstract_inverted_index: { By: [0], decomposing: [1], images: [2] },
			primary_location: {
				landing_page_url: "https://example.org/latent-diffusion",
			},
			best_oa_location: {
				landing_page_url: "https://oa.example.org/latent-diffusion",
				pdf_url: "https://oa.example.org/latent-diffusion.pdf",
			},
		},
		{
			id: "https://openalex.org/W999",
			title: "No Abstract Here",
			publication_date: "2023-01-01",
			abstract_inverted_index: null,
			primary_location: null,
		},
	],
});

describe("parseOpenalex", () => {
	it("maps works, reconstructs abstracts, and resolves the landing page", () => {
		const items = parseOpenalex(OPENALEX_SAMPLE);
		expect(items).toHaveLength(2);

		const [first, second] = items;
		expect(first?.externalId).toBe("W4312933868");
		expect(first?.abstract).toBe("By decomposing images");
		expect(first?.url).toBe("https://oa.example.org/latent-diffusion");
		expect(first?.pdfUrl).toBe("https://oa.example.org/latent-diffusion.pdf");
		expect(first?.publishedAt).toBe(Date.parse("2022-06-01"));

		// Missing abstract → empty string (poller/provider filters these out).
		expect(second?.abstract).toBe("");
		expect(second?.url).toBe("https://openalex.org/W999");
	});

	it("returns an empty list for malformed JSON", () => {
		expect(parseOpenalex("nope")).toEqual([]);
	});
});
