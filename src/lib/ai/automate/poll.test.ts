import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/lib/ai/db/client";
import type { Embedder } from "@/lib/ai/rag/ingest";
import { runPoll } from "./poll";
import { addSource, documentExists, getSource } from "./store";

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

	it("persists feed validators and short-circuits on a 304", async () => {
		db = openDatabase(":memory:");
		const source = addSource(
			{ type: "rss", url: "https://b.example/feed.xml", title: "Blog" },
			db,
		);

		// First poll: a 200 with validators, which must be persisted.
		const fetchWithValidators = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/1") || url.endsWith("/2")) {
				return new Response(articleHtml("cats"), {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			}
			return new Response(RSS_BODY, {
				status: 200,
				headers: { ETag: '"v1"', "Last-Modified": "Tue, 09 Jun 2026" },
			});
		}) as unknown as typeof fetch;
		await runPoll({ db, embedder, fetchFn: fetchWithValidators });
		expect(getSource(source.id, db)?.etag).toBe('"v1"');
		expect(getSource(source.id, db)?.lastModified).toBe("Tue, 09 Jun 2026");

		// Second poll: the stored validators ride along and a 304 short-circuits
		// to a healthy no-op (no article fetches, no errors).
		const calls: Record<string, string>[] = [];
		const fetch304 = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				calls.push((init?.headers ?? {}) as Record<string, string>);
				return new Response(null, { status: 304 });
			},
		) as unknown as typeof fetch;
		const summary = await runPoll({ db, embedder, fetchFn: fetch304 });
		expect(calls[0]?.["If-None-Match"]).toBe('"v1"');
		expect(summary.errors).toBe(0);
		expect(summary.added).toBe(0);
		expect(summary.perSource[0]?.status).toBe("ok");
		expect(fetch304).toHaveBeenCalledTimes(1);
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

describe("runPoll (papers)", () => {
	it("falls back to ingesting the abstract when no full text is available", async () => {
		db = openDatabase(":memory:");
		const source = addSource(
			{ type: "arxiv", url: "cat:cs.AI", title: "arXiv cs.AI" },
			db,
		);

		// Listing succeeds but the item has no PDF URL — the old behavior skipped
		// it forever; now the title+abstract are ingested once.
		const { getPaperProvider } = await import("./papers");
		const provider = getPaperProvider("arxiv");
		const listSpy = vi.spyOn(provider, "list").mockResolvedValue({
			ok: true,
			items: [
				{
					externalId: "2406.00001",
					title: "A Paper About Cats",
					abstract: "We study cats at considerable length and depth.",
					url: "https://arxiv.org/abs/2406.00001",
					publishedAt: Date.parse("2026-06-01T00:00:00Z"),
				},
			],
		});

		try {
			const summary = await runPoll({ db, embedder });
			expect(summary.added).toBe(1);
			expect(summary.errors).toBe(0);
			expect(summary.perSource[0]?.status).toBe("ok");
			expect(documentExists(source.id, "2406.00001", db)).toBe(true);

			const row = db
				.prepare(
					"SELECT c.content AS content FROM documents d JOIN chunks c ON c.document_id = d.id WHERE d.external_id = '2406.00001'",
				)
				.get() as { content: string };
			expect(row.content).toContain("A Paper About Cats");
			expect(row.content).toContain("We study cats");

			// Second run: the recorded item is skipped, never re-fetched.
			const second = await runPoll({ db, embedder });
			expect(second.added).toBe(0);
			expect(second.skipped).toBe(1);
		} finally {
			listSpy.mockRestore();
		}
	}, 15_000);
});

describe("runPoll (YouTube)", () => {
	it("ingests transcripts for new videos and dedups on a second run", async () => {
		db = openDatabase(":memory:");
		const source = addSource(
			{
				type: "youtube",
				url: "https://youtube.com/@chan",
				identifier: "UC123",
				title: "Chan",
			},
			db,
		);

		const youtube = {
			listVideos: vi.fn(async () => ({
				ok: true as const,
				videos: [
					{
						videoId: "vid-1",
						title: "How cats purr",
						url: "https://youtube.com/watch?v=vid-1",
						publishedAt: Date.parse("2026-06-01T00:00:00Z"),
					},
				],
			})),
			fetchTranscript: vi.fn(async () => ({
				ok: true as const,
				text: "Cats purr by vibrating their laryngeal muscles.",
			})),
		};

		const summary = await runPoll({ db, embedder, youtube });
		expect(summary.added).toBe(1);
		expect(summary.errors).toBe(0);
		expect(summary.perSource[0]?.status).toBe("ok");
		expect(documentExists(source.id, "vid-1", db)).toBe(true);

		const second = await runPoll({ db, embedder, youtube });
		expect(second.added).toBe(0);
		expect(second.skipped).toBe(1);
		// Transcript fetched once — the dedup check runs before the expensive work.
		expect(youtube.fetchTranscript).toHaveBeenCalledTimes(1);
	});
});
