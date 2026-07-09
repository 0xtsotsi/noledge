/**
 * people-cache.ts — writer for the `people_cache` table.
 *
 * Created during the "scan for work" pass (2026-07-09): the import
 * `import { upsertPeopleCache } from "@/lib/ai/people-cache"` in
 * src/app/api/bridge/ingest/route.ts (added by T31 / B15 silent-swallow
 * fix on 2026-07-06) referenced a module that was never extracted —
 * only the matching `ensurePeopleCacheTable` DDL made it into
 * src/lib/ai/db/schema.ts (added by T27 / B10 on the same day).
 *
 * The contract: upsert a (record_id) row with the latest emails + phones
 * JSON arrays; updated_at is epoch milliseconds at write time. ON CONFLICT
 * (record_id) the row is overwritten. Any thrown error surfaces unchanged
 * — B15 contract requires the route to convert it into a 500 JSON, never
 * silently swallow.
 *
 * Schema mirrors ensurePeopleCacheTable in src/lib/ai/db/schema.ts:309.
 */

import { getDatabase } from "./db/client";

export interface PeopleCacheRow {
	record_id: string;
	emails_json: string;
	phones_json: string;
	updated_at: number;
}

export function getPeopleCache(recordId: string): PeopleCacheRow | undefined {
	const row = getDatabase()
		.prepare(
			"SELECT record_id, emails_json, phones_json, updated_at FROM people_cache WHERE record_id = ?",
		)
		.get(recordId) as PeopleCacheRow | undefined;
	return row;
}

export function listPeopleCache(): PeopleCacheRow[] {
	return getDatabase()
		.prepare(
			"SELECT record_id, emails_json, phones_json, updated_at FROM people_cache ORDER BY updated_at DESC",
		)
		.all() as PeopleCacheRow[];
}

export function upsertPeopleCache(
	recordId: string,
	emails: readonly string[],
	phones: readonly string[],
): void {
	getDatabase()
		.prepare(
			`INSERT INTO people_cache (record_id, emails_json, phones_json, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(record_id) DO UPDATE SET
			   emails_json = excluded.emails_json,
			   phones_json = excluded.phones_json,
			   updated_at  = excluded.updated_at`,
		)
		.run(recordId, JSON.stringify(emails), JSON.stringify(phones), Date.now());
}

export function deletePeopleCache(recordId: string): void {
	getDatabase()
		.prepare("DELETE FROM people_cache WHERE record_id = ?")
		.run(recordId);
}
