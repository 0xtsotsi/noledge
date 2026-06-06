import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/ai/db/client";
import type { Embedder } from "@/lib/ai/rag/ingest";
import { runPoll } from "./poll";
import { addSource, documentExists } from "./store";

/** Deterministic embedder: one-hot vector so ingest always succeeds. */
const embedder: Embedder = async (values) => ({
	ok: true,
	embeddings: values.map(() => {
		const vector = new Array<number>(1536).fill(0);
		vector[0] = 1;
		return vector;
	}),
});

let db: Database | null = null;

afterEach(() => {
	db?.close();
	db = null;
});

const RSS_BODY = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title>
	<item><title>Post One</title><link>https://b.example/1</link><guid>g-1</guid><description>Body one about cats.</description></item>
	<item><title>Post Two</title><link>https://b.example/2</link><guid>g-2</guid><description>Body two about dogs.</description></item>
</channel></rss>`;

/** A full article page: long enough to chunk into several pieces, wrapped in
 * site boilerplate that Readability should strip. */
function articleHtml(topic: string): string {
	const paragraph = `This is a detailed paragraph about ${topic}. `.repeat(40);
	return `<!doctype html><html><head><title>${topic}</title></head><body>
		<nav>Home About Contact Subscribe Newsletter</nav>
		<header>Site banner and navigation junk</header>
		<article><h1>${topic}</h1>
			<p>${paragraph}</p>
			<p>${paragraph}</p>
			<p>${paragraph}</p>
		</article>
		<footer>Copyright cookie notice social links</footer>
	</body></html>`;
}

/** Route fetches: feed URL returns the RSS XML, article links return full HTML. */
function routedFetch(): typeof fetch {
	return vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/1")) {
			return new Response(articleHtml("cats"), {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}
		if (url.endsWith("/2")) {
			return new Response(articleHtml("dogs"), {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		}
		return new Response(RSS_BODY, { status: 200 });
	}) as unknown as typeof fetch;
}

describe("runPoll (RSS)", () => {
	it("ingests new feed items and dedups on a second run", async () => {
		db = openDatabase(":memory:");
		const source = addSource(
			{ type: "rss", url: "https://b.example/feed.xml", title: "Blog" },
			db,
		);

		const fetchFn = routedFetch();

		const first = await runPoll({ db, embedder, fetchFn });
		expect(first.added).toBe(2);
		expect(first.skipped).toBe(0);
		expect(first.errors).toBe(0);
		expect(documentExists(source.id, "g-1", db)).toBe(true);

		// Thin feed bodies were enriched from the article pages: each document
		// chunks into several pieces rather than a single near-empty chunk, and the
		// nav/footer boilerplate is stripped.
		const rows = db
			.prepare(
				`SELECT d.external_id AS externalId, COUNT(c.id) AS chunks,
					GROUP_CONCAT(c.content, ' ') AS body
				FROM documents d JOIN chunks c ON c.document_id = d.id
				GROUP BY d.id`,
			)
			.all() as { externalId: string; chunks: number; body: string }[];
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.chunks).toBeGreaterThan(1);
			expect(row.body).not.toContain("cookie notice");
			expect(row.body).not.toContain("navigation junk");
		}

		// Second poll: same items are all skipped, nothing re-ingested.
		const second = await runPoll({ db, embedder, fetchFn: routedFetch() });
		expect(second.added).toBe(0);
		expect(second.skipped).toBe(2);
	});

	it("records a source error without aborting the run", async () => {
		db = openDatabase(":memory:");
		addSource(
			{ type: "rss", url: "https://bad.example/feed", title: "Bad" },
			db,
		);

		const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
		const summary = await runPoll({ db, embedder, fetchFn });
		expect(summary.added).toBe(0);
		expect(summary.errors).toBe(1);
		expect(summary.perSource[0]?.status).toBe("error");
	});
});

describe("runPoll (YouTube)", () => {
	it("skips YouTube sources with coming-soon status", async () => {
		db = openDatabase(":memory:");
		addSource(
			{
				type: "youtube",
				url: "https://youtube.com/@chan",
				identifier: "UC123",
				title: "Chan",
			},
			db,
		);

		const summary = await runPoll({ db, embedder });
		expect(summary.added).toBe(0);
		expect(summary.skipped).toBe(0);
		expect(summary.errors).toBe(0);
	});
});
