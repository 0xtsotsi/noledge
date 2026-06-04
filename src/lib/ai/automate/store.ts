import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { getDatabase } from "@/lib/ai/db/client";

/**
 * Typed DB accessors for the automation feature: schedule config, source CRUD,
 * and the dedup existence check. YouTube discovery + transcripts run through the
 * unofficial InnerTube client, so no API key is stored here.
 */

export type SourceType = "rss" | "youtube";
export type SourceStatus = "ok" | "error" | "partial";

export type AutomationSource = {
	id: string;
	type: SourceType;
	url: string;
	identifier: string | null;
	title: string | null;
	enabled: boolean;
	createdAt: number;
	lastPolledAt: number | null;
	lastStatus: SourceStatus | null;
	lastError: string | null;
	lastItemCount: number;
};

export type AutomationConfig = {
	scheduleHour: number | null;
	timezone: string | null;
	lastRunAt: number | null;
};

type SourceRow = {
	id: string;
	type: string;
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

function mapSource(row: SourceRow): AutomationSource {
	return {
		id: row.id,
		type: row.type === "youtube" ? "youtube" : "rss",
		url: row.url,
		identifier: row.identifier,
		title: row.title,
		enabled: row.enabled !== 0,
		createdAt: row.created_at,
		lastPolledAt: row.last_polled_at,
		lastStatus: (row.last_status as SourceStatus | null) ?? null,
		lastError: row.last_error,
		lastItemCount: row.last_item_count,
	};
}

/** Read the singleton automation config row, or defaults when unset. */
export function getConfig(db: Database = getDatabase()): AutomationConfig {
	const row = db
		.prepare(
			"SELECT schedule_hour, timezone, last_run_at FROM automation_config WHERE id = 1",
		)
		.get() as
		| {
				schedule_hour: number | null;
				timezone: string | null;
				last_run_at: number | null;
		  }
		| undefined;
	return {
		scheduleHour: row?.schedule_hour ?? null,
		timezone: row?.timezone ?? null,
		lastRunAt: row?.last_run_at ?? null,
	};
}

/** Upsert the schedule hour + timezone on the singleton config row. */
export function putSchedule(
	scheduleHour: number | null,
	timezone: string | null,
	db: Database = getDatabase(),
): void {
	db.prepare(
		`INSERT INTO automation_config (id, schedule_hour, timezone)
		 VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET schedule_hour = excluded.schedule_hour, timezone = excluded.timezone`,
	).run(scheduleHour, timezone);
}

/** Record the timestamp of the most recent completed poll run. */
export function setLastRunAt(
	lastRunAt: number,
	db: Database = getDatabase(),
): void {
	db.prepare(
		`INSERT INTO automation_config (id, last_run_at)
		 VALUES (1, ?)
		 ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at`,
	).run(lastRunAt);
}

/** List all sources, newest first. */
export function listSources(db: Database = getDatabase()): AutomationSource[] {
	const rows = db
		.prepare("SELECT * FROM automation_sources ORDER BY created_at DESC")
		.all() as SourceRow[];
	return rows.map(mapSource);
}

/** List enabled sources only (what the poller iterates). */
export function listEnabledSources(
	db: Database = getDatabase(),
): AutomationSource[] {
	return listSources(db).filter((source) => source.enabled);
}

/** Look up a single source by id. */
export function getSource(
	id: string,
	db: Database = getDatabase(),
): AutomationSource | undefined {
	const row = db
		.prepare("SELECT * FROM automation_sources WHERE id = ?")
		.get(id) as SourceRow | undefined;
	return row ? mapSource(row) : undefined;
}

export type NewSource = {
	type: SourceType;
	url: string;
	identifier?: string | null;
	title?: string | null;
};

/**
 * Find an existing source that is the same feed/channel as the one being added,
 * so the add route can reject duplicates before re-ingesting the whole backlog.
 * YouTube channels are matched on their resolved `identifier` (channelId, stable
 * across URL/@handle variants); RSS feeds are matched on their `url`.
 */
export function findDuplicateSource(
	input: NewSource,
	db: Database = getDatabase(),
): AutomationSource | undefined {
	if (input.type === "youtube" && input.identifier) {
		const row = db
			.prepare(
				"SELECT * FROM automation_sources WHERE type = 'youtube' AND identifier = ? LIMIT 1",
			)
			.get(input.identifier) as SourceRow | undefined;
		return row ? mapSource(row) : undefined;
	}
	const row = db
		.prepare(
			"SELECT * FROM automation_sources WHERE type = ? AND url = ? LIMIT 1",
		)
		.get(input.type, input.url) as SourceRow | undefined;
	return row ? mapSource(row) : undefined;
}

/** Insert a new (resolved) source. Returns the stored row. */
export function addSource(
	input: NewSource,
	db: Database = getDatabase(),
): AutomationSource {
	const id = randomUUID();
	db.prepare(
		`INSERT INTO automation_sources (id, type, url, identifier, title, enabled, created_at, last_item_count)
		 VALUES (?, ?, ?, ?, ?, 1, ?, 0)`,
	).run(
		id,
		input.type,
		input.url,
		input.identifier ?? null,
		input.title ?? null,
		Date.now(),
	);
	const source = getSource(id, db);
	if (!source) throw new Error("Failed to read back inserted source.");
	return source;
}

/** Remove a source by id. Returns true if a row was deleted. */
export function deleteSource(
	id: string,
	db: Database = getDatabase(),
): boolean {
	const info = db
		.prepare("DELETE FROM automation_sources WHERE id = ?")
		.run(id);
	return info.changes > 0;
}

export type SourceStatusUpdate = {
	status: SourceStatus;
	error?: string | null;
	itemCount: number;
	polledAt?: number;
};

/** Update a source's post-poll status counters. */
export function updateSourceStatus(
	id: string,
	update: SourceStatusUpdate,
	db: Database = getDatabase(),
): void {
	db.prepare(
		`UPDATE automation_sources
		 SET last_status = ?, last_error = ?, last_item_count = ?, last_polled_at = ?
		 WHERE id = ?`,
	).run(
		update.status,
		update.error ?? null,
		update.itemCount,
		update.polledAt ?? Date.now(),
		id,
	);
}

/**
 * True when a document for `(sourceId, externalId)` already exists. The poller
 * calls this before doing expensive transcript/embedding work so re-ingestion is
 * never paid for.
 */
export function documentExists(
	sourceId: string,
	externalId: string,
	db: Database = getDatabase(),
): boolean {
	const row = db
		.prepare(
			"SELECT 1 FROM documents WHERE source_id = ? AND external_id = ? LIMIT 1",
		)
		.get(sourceId, externalId);
	return row !== undefined;
}
