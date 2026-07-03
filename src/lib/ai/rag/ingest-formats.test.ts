import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/ai/db/client";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/db/schema";
import type { Embedder } from "./ingest";
import { ingestDocument } from "./ingest";
import { retrieveChunks } from "./retrieve";

/**
 * End-to-end format coverage: drive every supported file type through the full
 * pipeline (extract → chunk → embed → store → retrieve) and assert each one
 * becomes a retrievable chunk. Embedding is faked deterministically so the test
 * needs no API key, but extraction, chunking, FTS indexing, and the SQL round
 * trip are all exercised for real.
 */

const FIXTURES = join(__dirname, "__fixtures__");

function fixture(name: string): Buffer {
	return readFileSync(join(FIXTURES, name));
}

/**
 * Hash text into a stable unit vector. Identical text → identical vector and any
 * query containing the same marker token lands near its chunk, so retrieval is
 * deterministic without a real embedding model.
 */
function fakeVector(text: string): number[] {
	const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
	const lower = text.toLowerCase();
	for (let i = 0; i < lower.length; i++) {
		const code = lower.charCodeAt(i);
		const idx = code % EMBEDDING_DIMENSIONS;
		vector[idx] = (vector[idx] ?? 0) + 1;
	}
	const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
	return vector.map((v) => v / norm);
}

const embedder: Embedder = async (values) => ({
	ok: true,
	embeddings: values.map(fakeVector),
});

let db: Database | null = null;

afterEach(() => {
	db?.close();
	db = null;
});

type FormatCase = {
	file: string;
	mime: string;
	/** Lowercase substring that must survive extraction into a stored chunk. */
	needle: string;
};

const cases: FormatCase[] = [
	{ file: "sample.txt", mime: "text/plain", needle: "quick brown fox" },
	{ file: "sample.md", mime: "text/markdown", needle: "markdown" },
	{ file: "sample.json", mime: "application/json", needle: "jsonmarker" },
	{
		file: "sample.pdf",
		mime: "application/pdf",
		needle: "hello world from a pdf",
	},
	{
		file: "sample.docx",
		mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		needle: "wordmarker",
	},
	{
		file: "sample.pptx",
		mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		needle: "slidemarker",
	},
	{
		file: "sample.xlsx",
		mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		needle: "cellmarker",
	},
	{
		file: "sample.odt",
		mime: "application/vnd.oasis.opendocument.text",
		needle: "textmarker",
	},
	{
		file: "sample.odp",
		mime: "application/vnd.oasis.opendocument.presentation",
		needle: "presentmarker",
	},
	{
		file: "sample.ods",
		mime: "application/vnd.oasis.opendocument.spreadsheet",
		needle: "spreadmarker",
	},
	{ file: "sample.rtf", mime: "application/rtf", needle: "richmarker" },
	{ file: "sample.html", mime: "text/html", needle: "htmlmarker" },
	{ file: "sample.csv", mime: "text/csv", needle: "csvmarker" },
];

describe("ingest pipeline across all document formats", () => {
	for (const { file, mime, needle } of cases) {
		it(`ingests ${file} and makes its content retrievable`, async () => {
			db = openDatabase(":memory:");

			const ingested = await ingestDocument(
				{ data: fixture(file), filename: file, mime },
				{ db, embedder },
			);
			expect(ingested.ok).toBe(true);
			if (!ingested.ok) return;
			expect(ingested.chunks).toBeGreaterThan(0);
			expect(ingested.duplicate).toBe(false);

			// The stored text contains the format's sentinel.
			const stored = db
				.prepare(
					"SELECT content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.filename = ?",
				)
				.all(file) as { content: string }[];
			const joined = stored.map((r) => r.content.toLowerCase()).join("\n");
			expect(joined).toContain(needle);

			// And the keyword arm can retrieve it by a token from the sentinel.
			const retrieved = await retrieveChunks(needle, {
				db,
				embedder,
				topK: 5,
			});
			expect(retrieved.ok).toBe(true);
			if (!retrieved.ok) return;
			const hit = retrieved.chunks.some((chunk) =>
				chunk.content.toLowerCase().includes(needle),
			);
			expect(hit).toBe(true);
		});
	}

	it("OCRs and ingests a standalone image", async () => {
		db = openDatabase(":memory:");
		const ingested = await ingestDocument(
			{ data: fixture("hello.png"), filename: "hello.png", mime: "image/png" },
			{ db, embedder },
		);
		expect(ingested.ok).toBe(true);
		if (!ingested.ok) return;
		expect(ingested.chunks).toBeGreaterThan(0);

		const stored = db
			.prepare(
				"SELECT content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.filename = ?",
			)
			.all("hello.png") as { content: string }[];
		expect(stored.map((r) => r.content.toLowerCase()).join("\n")).toContain(
			"hello",
		);
	}, 120_000);
});
