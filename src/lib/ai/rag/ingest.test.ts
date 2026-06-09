import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/ai/db/client";
import type { Embedder } from "./ingest";
import { ingestDocument, ingestText } from "./ingest";
import { retrieveChunks } from "./retrieve";

/**
 * Deterministic fake embedder: maps text to a 1536-dim vector keyed on the topic
 * keyword it contains, so semantically grouped docs cluster.
 */
const TOPICS = ["cat", "finance", "weather"];

function fakeEmbed(text: string): number[] {
	const vector: number[] = new Array<number>(1536);
	for (let i = 0; i < vector.length; i++) vector[i] = 0;
	const lower = text.toLowerCase();
	TOPICS.forEach((topic, index) => {
		if (lower.includes(topic)) vector[index] = 1;
	});
	// Fallback so empty matches still produce a valid unit-ish vector.
	let allZero = true;
	for (const value of vector) {
		if (value !== 0) {
			allZero = false;
			break;
		}
	}
	if (allZero) vector[1535] = 1;
	return vector;
}

const embedder: Embedder = async (values) => ({
	ok: true,
	embeddings: values.map(fakeEmbed),
});

let db: Database | null = null;

afterEach(() => {
	db?.close();
	db = null;
});

describe("ingest + retrieve", () => {
	it("ranks the semantically matching chunk first and round-trips metadata", async () => {
		db = openDatabase(":memory:");

		const docs = [
			{ title: "Cats", text: "The cat sat on the warm windowsill purring." },
			{
				title: "Finance",
				text: "Quarterly finance report shows strong revenue.",
			},
			{
				title: "Weather",
				text: "The weather forecast predicts heavy rain today.",
			},
		];

		for (const doc of docs) {
			const result = await ingestDocument(
				{
					data: Buffer.from(doc.text, "utf8"),
					filename: `${doc.title}.txt`,
					mime: "text/plain",
					title: doc.title,
				},
				{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
			);
			expect(result.ok).toBe(true);
		}

		const retrieved = await retrieveChunks("Tell me about the cat", {
			db,
			embedder,
			topK: 1,
		});

		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.chunks).toHaveLength(1);
		expect(retrieved.chunks[0]?.documentTitle).toBe("Cats");
		expect(retrieved.chunks[0]?.content.toLowerCase()).toContain("cat");
	});

	it("filters out chunks beyond the distance ceiling", async () => {
		db = openDatabase(":memory:");

		const docs = [
			{ title: "Cats", text: "The cat sat on the warm windowsill." },
			{ title: "Finance", text: "Quarterly finance report shows revenue." },
			{ title: "Weather", text: "The weather forecast predicts rain." },
		];
		for (const doc of docs) {
			await ingestDocument(
				{
					data: Buffer.from(doc.text, "utf8"),
					filename: `${doc.title}.txt`,
					mime: "text/plain",
					title: doc.title,
				},
				{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
			);
		}

		// The fake embedder makes non-matching topics orthogonal (cosine
		// distance 1.0); a strict ceiling must keep only the cat chunk even
		// though topK asks for more. (Keyword hits bypass the ceiling by design,
		// so the query avoids stopwords shared with the other docs.)
		const retrieved = await retrieveChunks("cat", {
			db,
			embedder,
			topK: 3,
			maxDistance: 0.5,
		});

		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.chunks).toHaveLength(1);
		expect(retrieved.chunks[0]?.documentTitle).toBe("Cats");
	});

	it("returns exactly the matching doc under a strict minScore (overfetch regression)", async () => {
		db = openDatabase(":memory:");
		const docs = [
			{ title: "Cats", text: "The cat sat on the warm windowsill." },
			{ title: "Finance", text: "Quarterly finance report shows revenue." },
			{ title: "Weather", text: "The weather forecast predicts rain." },
		];
		for (const doc of docs) {
			await ingestDocument(
				{
					data: Buffer.from(doc.text, "utf8"),
					filename: `${doc.title}.txt`,
					mime: "text/plain",
					title: doc.title,
				},
				{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
			);
		}

		// Strict floor with the keyword arm off; only the cat chunk clears it, and
		// the result is sliced — never throws, never under-returns the survivor.
		const retrieved = await retrieveChunks("cat", {
			db,
			embedder,
			topK: 3,
			hybrid: false,
			vectorWeight: 1,
			textWeight: 0,
			minScore: 0.9,
		});
		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.chunks).toHaveLength(1);
		expect(retrieved.chunks[0]?.documentTitle).toBe("Cats");
	});

	it("surfaces a keyword-only match the vector arm cannot represent", async () => {
		db = openDatabase(":memory:");
		const docs = [
			{ title: "Cats", text: "The cat sat on the warm windowsill." },
			{ title: "Errors", text: "System aborted with code ERRX9213 overnight." },
		];
		for (const doc of docs) {
			await ingestDocument(
				{
					data: Buffer.from(doc.text, "utf8"),
					filename: `${doc.title}.txt`,
					mime: "text/plain",
					title: doc.title,
				},
				{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
			);
		}

		// The fake embedder has no axis for "ERRX9213" (falls back to one-hot at
		// index 1535, orthogonal to every doc) — only the keyword arm can find it.
		const retrieved = await retrieveChunks("ERRX9213", {
			db,
			embedder,
			topK: 3,
		});
		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		const titles = retrieved.chunks.map((chunk) => chunk.documentTitle);
		expect(titles).toContain("Errors");
	});

	it("keeps keyword-only hits beyond FTS rank 1 (RRF fusion regression)", async () => {
		db = openDatabase(":memory:");
		const docs = [
			// Mentions the token twice so bm25 ranks it first in the keyword arm.
			{
				title: "CatLog",
				text: "Diagnostics cat log recorded ERRX9213 then ERRX9213 again.",
			},
			// Single mention → keyword rank 2+; the vector arm cannot represent
			// the token at all, so only RRF fusion can keep this hit alive.
			{
				title: "FinanceLog",
				text: "Finance batch failed with ERRX9213 overnight.",
			},
		];
		for (const doc of docs) {
			await ingestDocument(
				{
					data: Buffer.from(doc.text, "utf8"),
					filename: `${doc.title}.txt`,
					mime: "text/plain",
					title: doc.title,
				},
				{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
			);
		}

		// Query embeds to the fallback axis (orthogonal to every doc), so both
		// hits are keyword-only. The non-top FTS hit must survive the default
		// minScore — the old linear fusion discarded every FTS hit but rank 1.
		const retrieved = await retrieveChunks("ERRX9213", {
			db,
			embedder,
			topK: 3,
		});
		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		const titles = retrieved.chunks.map((chunk) => chunk.documentTitle);
		expect(titles).toContain("CatLog");
		expect(titles).toContain("FinanceLog");
	});

	it("ranks a chunk strong in both arms above one strong in a single arm", async () => {
		db = openDatabase(":memory:");
		const docs = [
			// Matches the "cat" vector axis AND contains the keyword "whiskers".
			{ title: "Both", text: "The cat groomed its whiskers on the sill." },
			// Only the keyword arm (whiskers); vector axis is unrelated.
			{
				title: "KeywordOnly",
				text: "Spare whiskers were sold at the finance fair.",
			},
		];
		for (const doc of docs) {
			await ingestDocument(
				{
					data: Buffer.from(doc.text, "utf8"),
					filename: `${doc.title}.txt`,
					mime: "text/plain",
					title: doc.title,
				},
				{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
			);
		}

		const retrieved = await retrieveChunks("cat whiskers", {
			db,
			embedder,
			topK: 2,
			mmr: false,
		});
		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.chunks[0]?.documentTitle).toBe("Both");
	});

	it("keeps the FTS index consistent after a document is deleted", async () => {
		db = openDatabase(":memory:");
		const ingest = await ingestDocument(
			{
				data: Buffer.from(
					"System aborted with code ERRX9213 overnight.",
					"utf8",
				),
				filename: "Errors.txt",
				mime: "text/plain",
				title: "Errors",
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(ingest.ok).toBe(true);

		// Delete the chunks (fires the chunks_fts delete trigger).
		db.prepare("DELETE FROM chunks").run();

		// A plain DELETE on an external-content FTS table would leave the index
		// malformed; the trigger's FTS5 'delete' command keeps a MATCH probe valid
		// and empty rather than throwing "database disk image is malformed".
		const probe = db
			.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 1")
			.get('"ERRX9213"');
		expect(probe).toBeUndefined();

		// An integrity check passes only when postings were removed correctly.
		expect(() =>
			db?.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')"),
		).not.toThrow();
	});

	it("writes provenance columns via ingestText", async () => {
		db = openDatabase(":memory:");
		const result = await ingestText(
			{
				text: "The cat sat on the warm windowsill purring.",
				title: "A blog post about a cat",
				filename: "cat-post",
				mime: "text/html",
				bytes: 42,
				sourceId: "src-1",
				externalId: "guid-1",
				sourceUrl: "https://example.com/cat",
				publishedAt: 1_700_000_000_000,
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(result.ok).toBe(true);

		const row = db
			.prepare(
				"SELECT source_id, external_id, source_url, published_at FROM documents WHERE source_id = ?",
			)
			.get("src-1") as {
			source_id: string;
			external_id: string;
			source_url: string;
			published_at: number;
		};
		expect(row.source_id).toBe("src-1");
		expect(row.external_id).toBe("guid-1");
		expect(row.source_url).toBe("https://example.com/cat");
		expect(row.published_at).toBe(1_700_000_000_000);
	});

	it("rejects a duplicate (source_id, external_id) via the unique index", async () => {
		db = openDatabase(":memory:");
		const input = {
			text: "The cat sat on the warm windowsill purring.",
			title: "Cat",
			filename: "cat",
			mime: "text/html",
			bytes: 10,
			sourceId: "src-1",
			externalId: "guid-1",
		} as const;
		const first = await ingestText(input, {
			db,
			embedder,
			chunkOptions: { size: 1000, overlap: 0 },
		});
		expect(first.ok).toBe(true);

		const second = await ingestText(input, {
			db,
			embedder,
			chunkOptions: { size: 1000, overlap: 0 },
		});
		expect(second.ok).toBe(false);
	});

	it("dedups identical manual uploads by content hash", async () => {
		db = openDatabase(":memory:");
		const first = await ingestDocument(
			{
				data: Buffer.from("The cat sat on the warm windowsill.", "utf8"),
				filename: "cat.txt",
				mime: "text/plain",
				title: "Cat",
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.duplicate).toBe(false);

		// Same content, different filename/title — still a duplicate upload.
		const second = await ingestDocument(
			{
				data: Buffer.from("The cat sat on the warm windowsill.", "utf8"),
				filename: "cat-copy.txt",
				mime: "text/plain",
				title: "Cat Copy",
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.duplicate).toBe(true);
		expect(second.documentId).toBe(first.documentId);

		// Only one document row exists.
		const { count } = db
			.prepare("SELECT COUNT(*) AS count FROM documents")
			.get() as { count: number };
		expect(count).toBe(1);
	});

	it("does not dedup an automation item against a manual upload of the same text", async () => {
		db = openDatabase(":memory:");
		const text = "The cat sat on the warm windowsill.";
		const manual = await ingestDocument(
			{
				data: Buffer.from(text, "utf8"),
				filename: "cat.txt",
				mime: "text/plain",
				title: "Cat",
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(manual.ok).toBe(true);

		// An automation item carries source provenance and is keyed by
		// (source_id, external_id), so it ingests independently.
		const auto = await ingestText(
			{
				text,
				title: "Cat",
				filename: "cat",
				mime: "text/plain",
				bytes: 10,
				sourceId: "src-1",
				externalId: "vid-1",
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(auto.ok).toBe(true);
		if (!auto.ok) return;
		expect(auto.duplicate).toBe(false);
	});

	it("filters retrieval by source publication date", async () => {
		db = openDatabase(":memory:");
		const oldDoc = await ingestText(
			{
				text: "The cat sat on the old windowsill.",
				title: "Old Cat",
				filename: "old-cat",
				mime: "text/plain",
				bytes: 10,
				sourceId: "src-1",
				externalId: "old",
				publishedAt: Date.parse("2026-06-01T12:00:00.000Z"),
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		const newDoc = await ingestText(
			{
				text: "The cat sat on the new windowsill.",
				title: "New Cat",
				filename: "new-cat",
				mime: "text/plain",
				bytes: 10,
				sourceId: "src-1",
				externalId: "new",
				publishedAt: Date.parse("2026-06-05T12:00:00.000Z"),
			},
			{ db, embedder, chunkOptions: { size: 1000, overlap: 0 } },
		);
		expect(oldDoc.ok).toBe(true);
		expect(newDoc.ok).toBe(true);

		const retrieved = await retrieveChunks("cat windowsill", {
			db,
			embedder,
			topK: 5,
			dateFrom: Date.parse("2026-06-04T00:00:00.000Z"),
			mmr: false,
		});
		expect(retrieved.ok).toBe(true);
		if (!retrieved.ok) return;
		expect(retrieved.chunks.map((chunk) => chunk.documentTitle)).toEqual([
			"New Cat",
		]);
		expect(retrieved.chunks[0]?.documentPublishedAt).toBe(
			Date.parse("2026-06-05T12:00:00.000Z"),
		);
	});

	it("rejects a document with no extractable text", async () => {
		db = openDatabase(":memory:");
		const result = await ingestDocument(
			{
				data: Buffer.from("   ", "utf8"),
				filename: "empty.txt",
				mime: "text/plain",
			},
			{ db, embedder },
		);
		expect(result.ok).toBe(false);
	});
});
