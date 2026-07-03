import { z } from "zod";
import { getDatabase } from "@/lib/ai/db/client";

export const runtime = "nodejs";

const querySchema = z.object({
	provider: z.string().optional().default("google-contacts"),
	limit: z.coerce.number().int().min(1).max(500).optional().default(50),
});

type ConflictRow = {
	id: string;
	provider: string;
	objectName: string;
	recordId: string;
	field: string;
	localValue: string | null;
	remoteValue: string | null;
	detectedAt: number;
};

/**
 * GET /api/sync/contacts/conflicts?provider=google-contacts&limit=50
 *
 * Returns the unresolved sync conflicts from the local `sync_conflicts`
 * table for the given provider. Auth-gated by `x-noledge-bridge-secret`
 * (same as the other bridge routes).
 *
 * Schema: the `sync_conflicts` table is created lazily by
 * `sync-contacts.ts::ensureConflictsTable()` and the `/api/sync/contacts`
 * POST route. On a fresh DB the table may not yet exist; we create it
 * here too so a GET against an empty Noledge doesn't 500.
 */
export async function GET(request: Request): Promise<Response> {
	const authHeader = request.headers.get("x-noledge-bridge-secret");
	const configured = process.env.NOLEDGE_BRIDGE_SECRET;
	if (!configured || authHeader !== configured) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const parsed = querySchema.safeParse({
		provider: url.searchParams.get("provider") ?? undefined,
		limit: url.searchParams.get("limit") ?? undefined,
	});
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid query", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const db = getDatabase();
	db.exec(
		`CREATE TABLE IF NOT EXISTS sync_conflicts (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			object_name TEXT NOT NULL,
			record_id TEXT NOT NULL,
			field TEXT NOT NULL,
			local_value TEXT,
			remote_value TEXT,
			detected_at INTEGER NOT NULL
		)`,
	);

	const rows = db
		.prepare(
			`SELECT id, provider, object_name, record_id, field, local_value, remote_value, detected_at
			 FROM sync_conflicts
			 WHERE provider = ?
			 ORDER BY detected_at DESC
			 LIMIT ?`,
		)
		.all(parsed.data.provider, parsed.data.limit) as Array<{
		id: string;
		provider: string;
		object_name: string;
		record_id: string;
		field: string;
		local_value: string | null;
		remote_value: string | null;
		detected_at: number;
	}>;

	const conflicts: ConflictRow[] = rows.map((row) => ({
		id: row.id,
		provider: row.provider,
		objectName: row.object_name,
		recordId: row.record_id,
		field: row.field,
		localValue: row.local_value,
		remoteValue: row.remote_value,
		detectedAt: row.detected_at,
	}));

	return Response.json({ ok: true, conflicts, total: conflicts.length });
}