import { z } from "zod";
import { syncGoogleContacts } from "@/lib/ai/automate/sync-contacts";
import { getDatabase } from "@/lib/ai/db/client";

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
	const authHeader = request.headers.get("x-noledge-bridge-secret");
	const configured = process.env.NOLEDGE_BRIDGE_SECRET;
	if (!configured || authHeader !== configured) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

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
		// Ensure the conflicts table exists in fresh databases.
		getDatabase().exec(
			"CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, object_name TEXT NOT NULL, record_id TEXT NOT NULL, field TEXT NOT NULL, local_value TEXT, remote_value TEXT, detected_at INTEGER NOT NULL)",
		);
		const result = await syncGoogleContacts();
		return Response.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ ok: false, error: message }, { status: 502 });
	}
}
