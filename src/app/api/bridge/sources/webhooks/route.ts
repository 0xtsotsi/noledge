import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/ai/db/client";
import { validateBridgeRequest } from "@/lib/bridge/auth";

export const runtime = "nodejs";

type WebhookSourceRow = {
	id: string;
	url: string;
	identifier: string | null;
	title: string | null;
	enabled: number;
	created_at: number;
	last_polled_at: number | null;
	last_status: string | null;
	last_error: string | null;
	last_item_count: number;
};

export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	const db = getDatabase();
	const rows = db
		.prepare(
			`SELECT id, url, identifier, title, enabled, created_at,
			        last_polled_at, last_status, last_error, last_item_count
			 FROM automation_sources
			 WHERE type = 'webhook'
			 ORDER BY created_at DESC
			 LIMIT 100`,
		)
		.all() as WebhookSourceRow[];

	const items = rows.map((r) => ({
		id: r.id,
		title: r.title,
		identifier: r.identifier,
		enabled: r.enabled !== 0,
		createdAt: new Date(r.created_at).toISOString(),
		lastPolledAt: r.last_polled_at
			? new Date(r.last_polled_at).toISOString()
			: null,
		lastStatus: r.last_status,
		lastError: r.last_error,
		lastItemCount: r.last_item_count,
		webhookUrl: `/api/bridge/ingest/webhook/${r.id}`,
	}));

	return NextResponse.json({ ok: true, count: items.length, items });
}
