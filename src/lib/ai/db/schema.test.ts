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
});
