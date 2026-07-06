import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

// In-memory DB shared with the route via vi.mock factory. Created before the
// factories run so vitest's hoisting captures a real DB reference.
const db = new BetterSqlite3(":memory:");
db.exec(`
	CREATE TABLE sync_conflicts (
		id              TEXT PRIMARY KEY,
		provider        TEXT NOT NULL,
		object_name     TEXT NOT NULL,
		record_id       TEXT NOT NULL,
		field           TEXT NOT NULL,
		local_value     TEXT,
		remote_value    TEXT,
		detected_at     INTEGER NOT NULL,
		resolved_at     INTEGER,
		resolved_choice TEXT
	);
`);

const BRIDGE_SECRET = "test-bridge-secret-12345";

vi.mock("@/lib/ai/db/client", () => ({
	getDatabase: () => db,
}));

vi.mock("@/lib/ai/env", () => ({
	getEnv: () => ({ NOLEDGE_BRIDGE_SECRET: BRIDGE_SECRET }),
}));

function authedRequest(url: string): Request {
	return new Request(url, {
		headers: { "x-noledge-bridge-secret": BRIDGE_SECRET },
	});
}

beforeEach(() => {
	db.exec("DELETE FROM sync_conflicts");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("GET /api/sync/contacts/conflicts", () => {
	it("returns 401 when the bridge secret header is missing", async () => {
		const req = new Request(
			"http://localhost/api/sync/contacts/conflicts?provider=google-contacts",
		);
		const res = await GET(req);
		expect(res.status).toBe(401);
	});

	it("only returns unresolved rows by default", async () => {
		db.exec(`INSERT INTO sync_conflicts
			(id, provider, object_name, record_id, field, local_value, remote_value, detected_at, resolved_at, resolved_choice)
			VALUES
			('c-open',  'google-contacts', 'contact', 'p/o', 'phone', '+1', '+2', 1, NULL, NULL),
			('c-done',  'google-contacts', 'contact', 'p/d', 'email', 'a',   'b',  2, 3,    'remote')`);

		const res = await GET(
			authedRequest(
				"http://localhost/api/sync/contacts/conflicts?provider=google-contacts",
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			conflicts: Array<{ id: string }>;
			total: number;
		};
		expect(body.ok).toBe(true);
		expect(body.total).toBe(1);
		const first = body.conflicts[0];
		expect(first?.id).toBe("c-open");
	});

	it("?includeResolved=true returns both open and resolved rows", async () => {
		db.exec(`INSERT INTO sync_conflicts
			(id, provider, object_name, record_id, field, local_value, remote_value, detected_at, resolved_at, resolved_choice)
			VALUES
			('c-open',  'google-contacts', 'contact', 'p/o', 'phone', '+1', '+2', 1, NULL, NULL),
			('c-done',  'google-contacts', 'contact', 'p/d', 'email', 'a',   'b',  2, 3,    'remote')`);

		const res = await GET(
			authedRequest(
				"http://localhost/api/sync/contacts/conflicts?provider=google-contacts&includeResolved=true",
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			conflicts: Array<{ id: string }>;
			total: number;
		};
		expect(body.ok).toBe(true);
		expect(body.total).toBe(2);
		const ids = body.conflicts.map((c) => c.id).sort();
		expect(ids).toEqual(["c-done", "c-open"]);
	});
});
