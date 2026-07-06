import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// B15 contract test for the bridge/ingest route.
//
// We need a `Database` handle that:
//   - Has the tables + columns `ingestText` reads/writes
//   - Is available before `vi.mock` factories run (vitest hoisting)
//
// `better-sqlite3`'s default build lacks `sqlite-vec`, so we cannot run the
// production `migrate()` (which tries to CREATE VIRTUAL TABLE vec_chunks).
// Instead we build the bare-minimum schema by hand. This is fine for the B15
// contract because the throw happens upstream of `ingestText`.
const db = new BetterSqlite3(":memory:");
db.pragma("foreign_keys = ON");
db.exec(`
	CREATE TABLE documents (
		id          TEXT PRIMARY KEY,
		title       TEXT NOT NULL,
		filename    TEXT NOT NULL,
		mime        TEXT NOT NULL,
		bytes       INTEGER NOT NULL,
		source_id   TEXT,
		external_id TEXT,
		source_url  TEXT,
		content_hash TEXT,
		published_at INTEGER,
		created_at  INTEGER NOT NULL
	);
	CREATE INDEX idx_documents_source_external
		ON documents(source_id, external_id) WHERE external_id IS NOT NULL;
	CREATE INDEX idx_documents_content_hash
		ON documents(content_hash) WHERE content_hash IS NOT NULL;

	CREATE TABLE chunks (
		id          TEXT PRIMARY KEY,
		document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
		ordinal     INTEGER NOT NULL,
		content     TEXT NOT NULL,
		start       INTEGER,
		end         INTEGER
	);
	CREATE INDEX idx_chunks_document_id ON chunks(document_id);

	CREATE TABLE people_cache (
		record_id    TEXT PRIMARY KEY,
		emails_json  TEXT NOT NULL,
		phones_json  TEXT NOT NULL,
		updated_at   INTEGER NOT NULL
	);
`);

const BRIDGE_SECRET = "test-bridge-secret-12345";

vi.mock("@/lib/ai/db/client", () => ({
	getDatabase: () => db,
	openDatabase: () => db,
}));

vi.mock("@/lib/ai/env", () => ({
	getEnv: () => ({ NOLEDGE_BRIDGE_SECRET: BRIDGE_SECRET }),
}));

const ingestTextMock = vi.fn(async () => ({
	ok: true as const,
	documentId: "stub-document-id",
	chunks: 1,
	duplicate: false,
}));

vi.mock("@/lib/ai/rag/ingest", () => ({
	ingestText: ingestTextMock as unknown as typeof import("@/lib/ai/rag/ingest").ingestText,
	ingestDocument: vi.fn(async () => ({
		ok: true as const,
		documentId: "stub-document-id",
		chunks: 1,
		duplicate: false,
	})),
}));

function authedRequest(body: unknown): Request {
	return new Request("http://localhost/api/bridge/ingest", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-noledge-bridge-secret": BRIDGE_SECRET,
		},
		body: JSON.stringify(body),
	});
}

const { POST } = await import("./route");

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	db.exec("DELETE FROM chunks; DELETE FROM documents;");
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	ingestTextMock.mockClear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /api/bridge/ingest — B15 contract", () => {
	it("returns 500 with structured JSON when upsertPeopleCache throws (was previously silently swallowed)", async () => {
		// Simulate any DB-side people-cache failure: schema drift, disk full,
		// lock contention. The route must be loud (logged) and surface a 500
		// JSON body matching the route's other `ok:false` shape so callers
		// (Twenty bridge) can parse the error — never a deceptive 200.
		const peopleCache = await import("@/lib/ai/people-cache");
		const boom = new Error("no such table: people_cache");
		vi.spyOn(peopleCache, "upsertPeopleCache").mockImplementation(() => {
			throw boom;
		});

		const res = await POST(
			authedRequest({
				source: "twenty",
				objectName: "contact",
				recordId: "rec-1",
				title: "Acme contact",
				text: "Reach me at kim@acme.test.",
				fields: { emails: ["kim@acme.test"], phones: [] },
			}),
		);

		expect(res.status).toBe(500);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("people_cache");

		// Diagnostic visible in the bridge log.
		expect(errorSpy).toHaveBeenCalled();
		const calls = errorSpy.mock.calls
			.flat()
			.map((c: unknown) => (typeof c === "string" ? c : String(c)))
			.join(" ");
		expect(calls).toContain("upsertPeopleCache");

		// The RAG ingest must NOT run when the mirror is unhealthy — better
		// to surface the 500 than pollute the index against a stale mirror.
		expect(ingestTextMock).not.toHaveBeenCalled();
	});

	it("skips the people-cache branch entirely for non-contact objectName", async () => {
		const peopleCache = await import("@/lib/ai/people-cache");
		const spy = vi.spyOn(peopleCache, "upsertPeopleCache");

		const res = await POST(
			authedRequest({
				source: "twenty",
				objectName: "company", // not "contact"
				recordId: "rec-2",
				title: "Acme Inc.",
				text: "A widget company.",
			}),
		);

		expect(res.status).toBe(200);
		expect(spy).not.toHaveBeenCalled();
		expect(ingestTextMock).toHaveBeenCalledTimes(1);
	});

	it("happy path: logs nothing on success", async () => {
		const res = await POST(
			authedRequest({
				source: "twenty",
				objectName: "contact",
				recordId: "rec-3",
				title: "Quiet contact",
				text: "Reachable via email.",
				fields: { emails: ["q@example.test"], phones: [] },
			}),
		);
		expect(res.status).toBe(200);
		const calls = errorSpy.mock.calls
			.flat()
			.map((c: unknown) => (typeof c === "string" ? c : String(c)))
			.join(" ");
		expect(calls).not.toContain("upsertPeopleCache");
	});
});
