import { z } from "zod";
import { syncGoogleContacts } from "@/lib/ai/automate/sync-contacts";
import { getDatabase } from "@/lib/ai/db/client";
import { validateBridgeRequest } from "@/lib/bridge/auth";

export const runtime = "nodejs";

const syncRequestSchema = z.object({
	direction: z.enum(["pull", "push", "both"]).optional().default("both"),
});

/**
 * POST /api/sync/contacts — kick off a Google Contacts sync. The body
 * `direction` selects pull (Google → Twenty), push (Twenty → Google), or
 * both. For now the route returns the summary (pulled count + conflicts
 * count); v2 will stream events as the sync progresses.
 *
 * Auth: requires the operator to have authorised the Google Contacts scope
 * via `/api/providers/oauth/complete`. Anonymous callers get 401.
 *
 * This is the CRON entry point. A scheduler can hit it every 6 hours;
 * the actual cadence is operator-configured (see `automation_config`).
 */
export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown = {};
	try {
		raw = await request.json();
	} catch {
		// Empty body is fine — defaults apply.
	}
	const parsed = syncRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	try {
		// Ensure the conflicts table exists in fresh databases — the canonical
		// migration lives in `src/lib/ai/db/schema.ts`, but older DBs created
		// before `resolved_at` was added still need the column at runtime.
		const db = getDatabase();
		db.exec(
			"CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, object_name TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL, local_value TEXT, remote_value TEXT, detected_at INTEGER NOT NULL, resolved_at INTEGER)",
		);
		// Best-effort column add for pre-existing tables. PRAGMA returns the
		// `resolved_at` row when it already exists; otherwise we ALTER it in.
		const cols = db
			.prepare("PRAGMA table_info(sync_conflicts)")
			.all() as Array<{
			name: string;
		}>;
		if (!cols.some((c) => c.name === "resolved_at")) {
			db.exec("ALTER TABLE sync_conflicts ADD COLUMN resolved_at INTEGER");
		}
		const result = await syncGoogleContacts(fetch);
		return Response.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ ok: false, error: message }, { status: 502 });
	}
}
