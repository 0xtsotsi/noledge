import BetterSqlite3, { type Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { keywordSearch } from "./keyword";

let db: Database | null = null;

afterEach(() => {
	db?.close();
	db = null;
});

/** Minimal schema with the FTS5 index, no sqlite-vec needed for keyword tests. */
function setupFtsDb(): Database {
	const fresh = new BetterSqlite3(":memory:");
	fresh.exec(`
		CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL);
		CREATE TABLE chunks (
			id TEXT PRIMARY KEY,
			document_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			content TEXT NOT NULL
		);
		CREATE VIRTUAL TABLE chunks_fts USING fts5(
			content, content='chunks', content_rowid='rowid', tokenize='unicode61'
		);
	`);
	return fresh;
}

function insert(database: Database, id: string, content: string): void {
	database
		.prepare("INSERT INTO documents (id, title) VALUES (?, ?)")
		.run(`doc-${id}`, `Doc ${id}`);
	const info = database
		.prepare(
			"INSERT INTO chunks (id, document_id, ordinal, content) VALUES (?, ?, ?, ?)",
		)
		.run(id, `doc-${id}`, 0, content);
	database
		.prepare("INSERT INTO chunks_fts (rowid, content) VALUES (?, ?)")
		.run(info.lastInsertRowid, content);
}

describe("keywordSearch", () => {
	it("finds a chunk by a rare exact term", () => {
		db = setupFtsDb();
		insert(db, "a", "The configuration failed with error ERRX9213 last night.");
		insert(db, "b", "A gentle breeze drifted across the open meadow at dawn.");

		const hits = keywordSearch(db, "ERRX9213", 10);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.chunkId).toBe("a");
	});

	it("returns [] for a malformed query rather than throwing", () => {
		db = setupFtsDb();
		insert(db, "a", "hello world");
		// Pure punctuation sanitizes to empty → no match expression.
		expect(keywordSearch(db, '"()*:', 10)).toEqual([]);
	});

	it("returns [] when the FTS table is missing", () => {
		db = new BetterSqlite3(":memory:");
		db.exec(
			"CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT, ordinal INTEGER, content TEXT)",
		);
		expect(keywordSearch(db, "anything", 10)).toEqual([]);
	});

	it("returns [] for a non-positive limit", () => {
		db = setupFtsDb();
		insert(db, "a", "hello world");
		expect(keywordSearch(db, "hello", 0)).toEqual([]);
	});
});
