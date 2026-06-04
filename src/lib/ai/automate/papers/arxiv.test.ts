import { describe, expect, it } from "vitest";
import { parseArxiv } from "./arxiv";

const ARXIV_SAMPLE = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>arXiv Query: search_query=cat:cs.AI</title>
	<entry>
		<id>http://arxiv.org/abs/2606.05158v1</id>
		<title>Streaming Communication in Multi-Agent Reasoning</title>
		<updated>2026-06-03T17:57:04Z</updated>
		<published>2026-06-03T17:57:04Z</published>
		<summary>Multi-agent reasoning systems adopt a paradigm that forces latency.</summary>
		<link href="https://arxiv.org/abs/2606.05158v1" rel="alternate" type="text/html"/>
		<link href="https://arxiv.org/pdf/2606.05158v1" rel="related" type="application/pdf"/>
	</entry>
	<entry>
		<id>http://arxiv.org/abs/2606.04000v2</id>
		<title>Another Paper &amp; Title</title>
		<published>2026-06-02T10:00:00Z</published>
		<summary>A second abstract body.</summary>
		<link href="https://arxiv.org/abs/2606.04000v2" rel="alternate" type="text/html"/>
	</entry>
</feed>`;

describe("parseArxiv", () => {
	it("extracts id, title, abstract, url, and published date", () => {
		const items = parseArxiv(ARXIV_SAMPLE);
		expect(items).toHaveLength(2);

		const [first, second] = items;
		expect(first?.externalId).toBe("2606.05158v1");
		expect(first?.title).toBe(
			"Streaming Communication in Multi-Agent Reasoning",
		);
		expect(first?.abstract).toContain("Multi-agent reasoning systems");
		expect(first?.url).toBe("https://arxiv.org/abs/2606.05158v1");
		expect(first?.publishedAt).toBe(Date.parse("2026-06-03T17:57:04Z"));

		expect(second?.externalId).toBe("2606.04000v2");
		expect(second?.title).toBe("Another Paper & Title");
	});

	it("returns an empty list for malformed XML", () => {
		expect(parseArxiv("not xml")).toEqual([]);
		expect(parseArxiv("<feed></feed>")).toEqual([]);
	});
});
