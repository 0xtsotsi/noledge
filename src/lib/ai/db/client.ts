import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { getEnv } from "@/lib/ai/env";
import { migrate } from "./schema";

/**
 * Best-effort tighten of database file permissions to owner-only. The DB holds
 * provider API keys and OAuth tokens in plaintext, so a default world-readable
 * mode would expose them to every local user. Failures (e.g. Windows, exotic
 * filesystems) are ignored — this is hardening, not a hard requirement.
 */
function restrictDatabasePermissions(filePath: string): void {
	try {
		chmodSync(dirname(filePath), 0o700);
	} catch {
		/* best-effort */
	}
	for (const path of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
		try {
			if (existsSync(path)) chmodSync(path, 0o600);
		} catch {
			/* best-effort */
		}
	}
}

/**
 * Open a better-sqlite3 connection with the sqlite-vec extension loaded and the
 * schema migrated. Asserts `vec_version()` so a failed native load surfaces with
 * a clear error rather than later, cryptic SQL failures.
 */
export function openDatabase(filePath: string): Database {
	if (filePath !== ":memory:") {
		mkdirSync(dirname(filePath), { recursive: true });
	}

	const db = new BetterSqlite3(filePath);
	db.pragma("journal_mode = WAL");
	// Wait briefly on a locked database instead of failing immediately — the
	// poller and chat routes can write concurrently from separate connections.
	db.pragma("busy_timeout = 3000");
	// Standard WAL pairing: fsync at checkpoints only; safe against app crashes.
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");

	if (filePath !== ":memory:") {
		restrictDatabasePermissions(filePath);
	}

	sqliteVec.load(db);
	const row = db.prepare("SELECT vec_version() AS version").get() as
		| { version: string }
		| undefined;
	if (!row?.version) {
		db.close();
		throw new Error(
			"sqlite-vec extension failed to load: vec_version() returned no value.",
		);
	}

	migrate(db);
	return db;
}

// Stashed on globalThis so dev-mode HMR module reloads reuse the existing
// handle instead of leaking one connection per reload.
const globalForDb = globalThis as unknown as { __noledgeDb?: Database };

/** Process-wide singleton connection to the on-disk noledge database. */
export function getDatabase(): Database {
	if (globalForDb.__noledgeDb) return globalForDb.__noledgeDb;
	const db = openDatabase(getEnv().dbPath);
	globalForDb.__noledgeDb = db;
	return db;
}
