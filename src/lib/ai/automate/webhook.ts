/**
 * Generic webhook ingest — accepts an inbound JSON payload from any HTTP
 * service (Slack events, Notion automations, Postmark inbound, custom
 * integrations) and routes it through the same `ingestText` pipeline as
 * RSS / YouTube / papers.
 *
 * The (sourceId, externalId) unique index handles dedup, so retries are safe.
 *
 * The bridge's `automation_sources` table has a `type` column that's free-form
 * text. New rows can be inserted with type='webhook' directly. The store's
 * `SourceType` union has been extended to include 'webhook' so the rest of
 * the automation layer can recognise these sources.
 */

import { getDatabase } from "@/lib/ai/db/client";
import { type IngestResult, ingestText } from "@/lib/ai/rag/ingest";
import { updateSourceStatus } from "./store";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function extractWebhookText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!isRecord(payload)) return JSON.stringify(payload);
	for (const key of ["text", "body", "content", "message", "description"]) {
		const v = payload[key];
		if (typeof v === "string" && v.trim() !== "") return v;
	}
	if (isRecord(payload.message) && typeof payload.message.text === "string") {
		return payload.message.text;
	}
	if (Array.isArray(payload.blocks)) {
		// Slack message blocks — concatenate text fields
		const parts: string[] = [];
		for (const b of payload.blocks) {
			if (!isRecord(b)) continue;
			if (isRecord(b.text) && typeof b.text.text === "string") {
				parts.push(b.text.text);
			} else if (typeof b.text === "string") {
				parts.push(b.text);
			}
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return JSON.stringify(payload, null, 2);
}

export type HandleWebhookOptions = {
	sourceId: string;
	payload: unknown;
	externalId?: string;
	title?: string;
};

export type HandleWebhookResult =
	| {
			ok: true;
			documentId: string;
			chunks: number;
			duplicate: boolean;
			sourceId: string;
	  }
	| { ok: false; error: string; sourceId: string };

export async function handleWebhookIngest(
	options: HandleWebhookOptions,
): Promise<HandleWebhookResult> {
	const { sourceId, payload, externalId, title } = options;

	// Look up the source so we can confirm type='webhook' and get its title.
	const db = getDatabase();
	const row = db
		.prepare(
			"SELECT id, type, title FROM automation_sources WHERE id = ? AND enabled = 1",
		)
		.get(sourceId) as
		| { id: string; type: string; title: string | null }
		| undefined;

	if (!row) {
		return {
			ok: false,
			error: `Source ${sourceId} not found or disabled.`,
			sourceId,
		};
	}
	if (row.type !== "webhook") {
		return {
			ok: false,
			error: `Source ${sourceId} is type=${row.type}, not webhook.`,
			sourceId,
		};
	}

	const resolvedTitle = title ?? row.title ?? `Webhook ${sourceId} payload`;
	const text = extractWebhookText(payload);
	if (!text || text.trim() === "") {
		updateSourceStatus(sourceId, {
			status: "error",
			error: "Empty payload text",
			itemCount: 0,
		});
		return {
			ok: false,
			error: "Payload produced no extractable text.",
			sourceId,
		};
	}

	const extId =
		externalId ??
		`webhook-${sourceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	let result: IngestResult;
	try {
		result = await ingestText({
			text,
			title: resolvedTitle,
			filename: `${extId}.txt`,
			mime: "text/plain",
			bytes: Buffer.byteLength(text, "utf8"),
			sourceId: `webhook:${sourceId}`,
			externalId: extId,
			sourceUrl: undefined,
			publishedAt: Date.now(),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		updateSourceStatus(sourceId, {
			status: "error",
			error: message,
			itemCount: 0,
		});
		return { ok: false, error: message, sourceId };
	}

	if (!result.ok) {
		updateSourceStatus(sourceId, {
			status: "error",
			error: result.error,
			itemCount: 0,
		});
		return { ok: false, error: result.error, sourceId };
	}

	updateSourceStatus(sourceId, {
		status: result.duplicate ? "skipped" : "ok",
		itemCount: result.duplicate ? 0 : 1,
	});
	// Webhooks are push, not poll, so we deliberately skip:
	//   - setLastRunAt(Date.now()) — that updates the global `automation_config.last_run_at`
	//     shared with the poller, and a webhook is not a poll.
	//   - setSourceHttpCache(id, { etag: null, lastModified: null }) — there is no HTTP
	//     cache to record. Per-source `last_polled_at` is updated by `updateSourceStatus` above.

	return {
		ok: true,
		documentId: result.documentId,
		chunks: result.chunks,
		duplicate: result.duplicate,
		sourceId,
	};
}
