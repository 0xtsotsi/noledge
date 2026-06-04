import { describe, expect, it } from "vitest";
import { parsePmids, parsePubmedArticles } from "./pubmed";

describe("parsePmids", () => {
	it("reads the ordered PMID list from an esearch response", () => {
		const body = JSON.stringify({
			esearchresult: { idlist: ["42169267", "42165084"] },
		});
		expect(parsePmids(body)).toEqual(["42169267", "42165084"]);
	});

	it("returns an empty list for malformed or empty responses", () => {
		expect(parsePmids("nope")).toEqual([]);
		expect(parsePmids(JSON.stringify({ esearchresult: {} }))).toEqual([]);
	});
});

const EFETCH_SAMPLE = `<?xml version="1.0" ?>
<PubmedArticleSet>
	<PubmedArticle>
		<MedlineCitation Status="MEDLINE">
			<PMID Version="1">42169267</PMID>
			<Article PubModel="Print">
				<Journal>
					<JournalIssue>
						<PubDate><Year>2025</Year><Month>Feb</Month><Day>15</Day></PubDate>
					</JournalIssue>
				</Journal>
				<ArticleTitle>Type I corn resistant starch attenuates obesity</ArticleTitle>
				<Abstract>
					<AbstractText Label="BACKGROUND">The preventive effect of RS1.</AbstractText>
					<AbstractText Label="RESULTS">Body weight decreased.</AbstractText>
				</Abstract>
			</Article>
		</MedlineCitation>
	</PubmedArticle>
</PubmedArticleSet>`;

describe("parsePubmedArticles", () => {
	it("extracts pmid, title, labeled abstract, url, and pub date", () => {
		const items = parsePubmedArticles(EFETCH_SAMPLE);
		expect(items).toHaveLength(1);

		const [item] = items;
		expect(item?.externalId).toBe("42169267");
		expect(item?.title).toBe("Type I corn resistant starch attenuates obesity");
		expect(item?.abstract).toContain("BACKGROUND: The preventive effect");
		expect(item?.abstract).toContain("RESULTS: Body weight decreased.");
		expect(item?.url).toBe("https://pubmed.ncbi.nlm.nih.gov/42169267/");
		expect(item?.publishedAt).toBe(Date.parse("15 Feb 2025"));
	});

	it("returns an empty list for malformed XML", () => {
		expect(parsePubmedArticles("nope")).toEqual([]);
	});
});
