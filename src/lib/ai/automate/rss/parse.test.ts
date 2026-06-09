import { describe, expect, it, vi } from "vitest";
import { fetchFeed, parseFeed } from "./parse";

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel>
		<title>Example Blog</title>
		<link>https://example.com</link>
		<item>
			<title>First &amp; Foremost</title>
			<link>https://example.com/first</link>
			<guid isPermaLink="false">post-0001</guid>
			<pubDate>Tue, 03 Jun 2025 09:00:00 GMT</pubDate>
			<content:encoded><![CDATA[<p>Hello <strong>world</strong>.</p>]]></content:encoded>
		</item>
		<item>
			<title>No GUID Here</title>
			<link>https://example.com/second</link>
			<description>Plain &lt;b&gt;summary&lt;/b&gt; text.</description>
		</item>
	</channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>Atom Example</title>
	<entry>
		<title>Atom Entry One</title>
		<id>urn:uuid:1225c695-cfb8</id>
		<link rel="alternate" href="https://example.org/atom-one"/>
		<published>2025-06-01T12:30:00Z</published>
		<content type="html">&lt;p&gt;Body of the entry.&lt;/p&gt;</content>
	</entry>
</feed>`;

describe("parseFeed (RSS)", () => {
	it("extracts title, items, and normalized content", () => {
		const feed = parseFeed(RSS_SAMPLE);
		expect(feed.title).toBe("Example Blog");
		expect(feed.items).toHaveLength(2);

		const [first, second] = feed.items;
		expect(first?.title).toBe("First & Foremost");
		expect(first?.guid).toBe("post-0001");
		expect(first?.link).toBe("https://example.com/first");
		expect(first?.content).toContain("Hello world");
		expect(first?.content).not.toContain("<strong>");
		expect(first?.publishedAt).toBe(
			Date.parse("Tue, 03 Jun 2025 09:00:00 GMT"),
		);

		// guid falls back to the link when absent.
		expect(second?.guid).toBe("https://example.com/second");
		expect(second?.content).toContain("summary");
		expect(second?.publishedAt).toBeNull();
	});

	it("strips script and style contents from item bodies", () => {
		const feed = parseFeed(`<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title>
	<item>
		<title>Scripted</title>
		<link>https://example.com/s</link>
		<description><![CDATA[<p>Visible prose.</p><script>var tracked = "secret";</script><style>.a { color: red; }</style><p>More prose.</p>]]></description>
	</item>
</channel></rss>`);
		const [item] = feed.items;
		expect(item?.content).toContain("Visible prose.");
		expect(item?.content).toContain("More prose.");
		expect(item?.content).not.toContain("tracked");
		expect(item?.content).not.toContain("color: red");
	});
});

const RDF_SAMPLE = `<?xml version="1.0"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
	<channel rdf:about="https://rdf.example/">
		<title>RDF Example</title>
	</channel>
	<item rdf:about="https://rdf.example/a">
		<title>RDF Item</title>
		<link>https://rdf.example/a</link>
		<description>RDF body text.</description>
		<dc:date>2025-06-02T08:00:00Z</dc:date>
	</item>
</rdf:RDF>`;

describe("parseFeed (RDF / RSS 1.0)", () => {
	it("reads channel title and sibling items", () => {
		const feed = parseFeed(RDF_SAMPLE);
		expect(feed.title).toBe("RDF Example");
		expect(feed.items).toHaveLength(1);
		const [item] = feed.items;
		expect(item?.title).toBe("RDF Item");
		expect(item?.guid).toBe("https://rdf.example/a");
		expect(item?.content).toContain("RDF body text");
		expect(item?.publishedAt).toBe(Date.parse("2025-06-02T08:00:00Z"));
	});
});

describe("parseFeed (Atom)", () => {
	it("extracts entries via id + alternate link", () => {
		const feed = parseFeed(ATOM_SAMPLE);
		expect(feed.title).toBe("Atom Example");
		expect(feed.items).toHaveLength(1);

		const [entry] = feed.items;
		expect(entry?.title).toBe("Atom Entry One");
		expect(entry?.guid).toBe("urn:uuid:1225c695-cfb8");
		expect(entry?.link).toBe("https://example.org/atom-one");
		expect(entry?.content).toContain("Body of the entry");
		expect(entry?.publishedAt).toBe(Date.parse("2025-06-01T12:30:00Z"));
	});

	it("collects xhtml-typed content from its div element tree", () => {
		const feed = parseFeed(`<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>Xhtml Feed</title>
	<entry>
		<title>Xhtml Entry</title>
		<id>urn:uuid:xhtml-1</id>
		<link rel="alternate" href="https://example.org/xhtml"/>
		<content type="xhtml">
			<div xmlns="http://www.w3.org/1999/xhtml">
				<p>First xhtml paragraph.</p>
				<p>Second <em>emphasised</em> paragraph.</p>
			</div>
		</content>
	</entry>
</feed>`);
		const [entry] = feed.items;
		expect(entry?.content).toContain("First xhtml paragraph.");
		expect(entry?.content).toContain("emphasised");
	});
});

describe("fetchFeed retry", () => {
	it("retries once on a transient 503 then succeeds", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response("busy", { status: 503 }))
			.mockResolvedValueOnce(
				new Response(RSS_SAMPLE, { status: 200 }),
			) as unknown as typeof fetch;

		const result = await fetchFeed("https://b.example/feed.xml", { fetchFn });
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(result.ok).toBe(true);
		if (result.ok && !result.notModified) {
			expect(result.feed.title).toBe("Example Blog");
		}
	});

	it("sends stored validators and treats 304 as not modified", async () => {
		const fetchFn = vi.fn(
			async () => new Response(null, { status: 304 }),
		) as unknown as typeof fetch;

		const result = await fetchFeed("https://b.example/feed.xml", {
			fetchFn,
			etag: '"v1"',
			lastModified: "Tue, 09 Jun 2026 00:00:00 GMT",
		});

		const headers = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers["If-None-Match"]).toBe('"v1"');
		expect(headers["If-Modified-Since"]).toBe("Tue, 09 Jun 2026 00:00:00 GMT");
		expect(result).toEqual({ ok: true, notModified: true });
	});

	it("returns response validators on a 200", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(RSS_SAMPLE, {
					status: 200,
					headers: {
						ETag: '"v2"',
						"Last-Modified": "Wed, 10 Jun 2026 00:00:00 GMT",
					},
				}),
		) as unknown as typeof fetch;

		const result = await fetchFeed("https://b.example/feed.xml", { fetchFn });
		expect(result.ok).toBe(true);
		if (!result.ok || result.notModified) return;
		expect(result.etag).toBe('"v2"');
		expect(result.lastModified).toBe("Wed, 10 Jun 2026 00:00:00 GMT");
	});

	it("does not retry a deterministic 404", async () => {
		const fetchFn = vi.fn(
			async () => new Response("nope", { status: 404 }),
		) as unknown as typeof fetch;

		const result = await fetchFeed("https://b.example/missing", { fetchFn });
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(false);
	});
});
