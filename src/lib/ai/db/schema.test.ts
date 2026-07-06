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

	it("adds conversations.user_id on existing dbs and backfills legacy rows", () => {
		db = openVecDb();
		// Simulate a pre-F5 DB: conversations table exists without user_id.
		db.exec(`
			CREATE TABLE conversations (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		db.prepare(
			"INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
		).run("c-legacy", "Old chat", 1, 1);

		migrate(db);

		const cols = columnNames(db, "conversations");
		expect(cols.has("user_id")).toBe(true);
		// Legacy rows must be backfilled to "default" so cross-memory
		// searches don't miss them.
		const row = db
			.prepare("SELECT user_id FROM conversations WHERE id = ?")
			.get("c-legacy") as { user_id: string };
		expect(row.user_id).toBe("default");
	});

	it("creates the people_cache table keyed by record_id (Twenty contact mirror)", () => {
		db = openVecDb();
		migrate(db);

		// Schema shape: keyed by Twenty's record_id; emails + phones stored as
		// JSON arrays so we don't need a separate join table for v1.
		expect(tableExists(db, "people_cache")).toBe(true);
		const cols = columnNames(db, "people_cache");
		expect(cols.has("record_id")).toBe(true);
		expect(cols.has("emails_json")).toBe(true);
		expect(cols.has("phones_json")).toBe(true);
		expect(cols.has("updated_at")).toBe(true);

		// Primary key is record_id — duplicate inserts must conflict so the
		// upsertPeopleCache ON CONFLICT branch is the only writer.
		const insert = db.prepare(
			"INSERT INTO people_cache (record_id, emails_json, phones_json, updated_at) VALUES (?, ?, ?, ?)",
		);
		insert.run("rec-1", "[]", "[]", 1);
		expect(() => insert.run("rec-1", "[]", "[]", 2)).toThrow(
			/UNIQUE constraint failed/,
		);
	});

	it("creates the sync_conflicts table with a nullable resolved_at and resolved_choice", () => {
		db = openVecDb();
		migrate(db);

		// Schema shape: one row per divergent field; `resolved_at` is the gate
		// that hides a row from the ConflictReviewPanel once dismissed;
		// `resolved_choice` records which side won
		// (`'remote'|'local'|null` for dismissals) so the resolve action's
		// audit trail survives the row being filtered out of the panel.
		expect(tableExists(db, "sync_conflicts")).toBe(true);
		const cols = columnNames(db, "sync_conflicts");
		expect(cols.has("id")).toBe(true);
		expect(cols.has("provider")).toBe(true);
		expect(cols.has("object_name")).toBe(true);
		expect(cols.has("record_id")).toBe(true);
		expect(cols.has("field")).toBe(true);
		expect(cols.has("local_value")).toBe(true);
		expect(cols.has("remote_value")).toBe(true);
		expect(cols.has("detected_at")).toBe(true);
		expect(cols.has("resolved_at")).toBe(true);
		expect(cols.has("resolved_choice")).toBe(true);

		// Insert with resolved_at = NULL + resolved_choice NULL (open), then
		// with resolved_at set + resolved_choice set (resolved via accept_remote).
		// Both must succeed; resolved_choice is optional so unresolved rows
		// leave it NULL without a separate column for "open".
		const insert = db.prepare(
			`INSERT INTO sync_conflicts
				(id, provider, object_name, record_id, field, local_value, remote_value, detected_at, resolved_at, resolved_choice)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		insert.run(
			"c-1",
			"google-contacts",
			"contact",
			"people/c1",
			"phone",
			"+1",
			"+2",
			1,
			null,
			null,
		);
		insert.run(
			"c-2",
			"google-contacts",
			"contact",
			"people/c2",
			"email",
			"a@x",
			"b@x",
			2,
			2,
			"remote",
		);

		const openCount = (
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL",
				)
				.get() as { n: number }
		).n;
		expect(openCount).toBe(1);

		// The resolved row must have its choice persisted alongside the
		// timestamp — that's the audit trail the conflict-review UI relies on.
		const resolved = db
			.prepare("SELECT resolved_choice FROM sync_conflicts WHERE id = ?")
			.get("c-2") as { resolved_choice: string | null };
		expect(resolved.resolved_choice).toBe("remote");
	});
});
