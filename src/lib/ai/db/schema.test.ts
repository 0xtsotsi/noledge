import BetterSqlite3, { type Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "./schema";

let db: Database | null = null;

afterEach(() => {
	db?.close();
	db = null;
});

/** Fresh in-memory db with the sqlite-vec extension loaded (vec0 needed). */
function openVecDb(): Database {
	const fresh = new BetterSqlite3(":memory:");
	sqliteVec.load(fresh);
	return fresh;
}

function tableExists(database: Database, name: string): boolean {
	return (
		database
			.prepare("SELECT name FROM sqlite_master WHERE name = ?")
			.get(name) !== undefined
	);
}

function columnNames(database: Database, table: string): Set<string> {
	const rows = database.prepare(`PRAGMA table_info(${table})`).all() as {
		name: string;
	}[];
	return new Set(rows.map((row) => row.name));
}

describe("migrate", () => {
	it("is idempotent when run twice and creates fts + span columns", () => {
		db = openVecDb();
		migrate(db);
		expect(() => migrate(db as Database)).not.toThrow();

		expect(tableExists(db, "chunks_fts")).toBe(true);
		const cols = columnNames(db, "chunks");
		expect(cols.has("start")).toBe(true);
		expect(cols.has("end")).toBe(true);
	});

	it("adds document provenance columns + automation tables", () => {
		db = openVecDb();
		migrate(db);

		const docCols = columnNames(db, "documents");
		expect(docCols.has("source_id")).toBe(true);
		expect(docCols.has("external_id")).toBe(true);
		expect(docCols.has("source_url")).toBe(true);
		expect(docCols.has("content_hash")).toBe(true);
		expect(docCols.has("published_at")).toBe(true);

		expect(tableExists(db, "automation_sources")).toBe(true);
		expect(tableExists(db, "automation_config")).toBe(true);
	});

	it("enforces the source/external_id unique index but allows NULL external_id", () => {
		db = openVecDb();
		migrate(db);

		const insert = db.prepare(
			"INSERT INTO documents (id, title, filename, mime, bytes, created_at, source_id, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		);
		insert.run("d1", "T", "t.txt", "text/plain", 1, 0, "s1", "vid-1");
		expect(() =>
			insert.run("d2", "T", "t.txt", "text/plain", 1, 0, "s1", "vid-1"),
		).toThrow();

		// Manual uploads keep external_id NULL and are never deduped against.
		insert.run("m1", "T", "a.txt", "text/plain", 1, 0, null, null);
		expect(() =>
			insert.run("m2", "T", "b.txt", "text/plain", 1, 0, null, null),
		).not.toThrow();
	});

	it("backfills the FTS index for rows that predate the fts table", () => {
		db = openVecDb();
		// Simulate a pre-upgrade DB: chunks exist, no FTS table yet.
		db.exec(`
			CREATE TABLE documents (
				id TEXT PRIMARY KEY, title TEXT NOT NULL, filename TEXT NOT NULL,
				mime TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
			);
			CREATE TABLE chunks (
				id TEXT PRIMARY KEY,
				document_id TEXT NOT NULL,
				ordinal INTEGER NOT NULL,
				content TEXT NOT NULL
			);
		`);
		db.prepare(
			"INSERT INTO documents (id, title, filename, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run("d1", "T", "t.txt", "text/plain", 1, 0);
		db.prepare(
			"INSERT INTO chunks (id, document_id, ordinal, content) VALUES (?, ?, ?, ?)",
		).run("c1", "d1", 0, "preexisting needle content");

		migrate(db);

		const row = db
			.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?")
			.get("needle") as { rowid: number } | undefined;
		expect(row).toBeDefined();
	});

	it("creates the recall_user_context table (Feature 5 — AI Recall)", () => {
		db = openVecDb();
		migrate(db);

		expect(tableExists(db, "recall_user_context")).toBe(true);
		const cols = columnNames(db, "recall_user_context");
		expect(cols.has("id")).toBe(true);
		expect(cols.has("user_id")).toBe(true);
		expect(cols.has("query")).toBe(true);
		expect(cols.has("summary")).toBe(true);
		expect(cols.has("created_at")).toBe(true);
	});
});
