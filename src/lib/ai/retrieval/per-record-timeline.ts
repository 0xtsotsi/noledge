import { z } from "zod";
import { getDatabase } from "@/lib/ai/db/client";

/**
 * Helper for Feature 8 (narrative timeline). Joins `timeline_activities`
 * with `documents` filtered by `external_id` matching the record's
 * `objectName:recordId` prefix, and returns a chronologically-sorted list.
 *
 * v1 reads from the local Noledge SQLite. The Twenty-side
 * `noledge-narrative-timeline.logic-function.ts` calls into the bridge to
 * fetch the activities for the record and then to `/api/recall` for the
 * narrative itself.
 */

export const timelineEntrySchema = z.object({
	id: z.string(),
	kind: z.enum(["timeline", "document", "meeting"]),
	title: z.string(),
	body: z.string(),
	occurredAt: z.number(),
	sourceUrl: z.string().optional(),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

const timelineActivityTable = `
	CREATE TABLE IF NOT EXISTS timeline_activities (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		properties TEXT,
		target_company_id TEXT,
		target_person_id TEXT,
		target_opportunity_id TEXT,
		target_note_id TEXT,
		created_at INTEGER NOT NULL
	)
`;

function ensureTimelineTable(): void {
	getDatabase().exec(timelineActivityTable);
}

const OBJECT_TO_COLUMN: Record<string, string> = {
	company: "target_company_id",
	person: "target_person_id",
	opportunity: "target_opportunity_id",
	note: "target_note_id",
};

/**
 * Read the timeline activities + ingested documents for a record, sorted
 * chronologically. Limits to the last `maxYears` (default 5) so the
 * narrative prompt doesn't exceed the model's context.
 */
export function perRecordTimeline(
	objectName: string,
	recordId: string,
	maxYears = 5,
): TimelineEntry[] {
	ensureTimelineTable();
	const db = getDatabase();
	const column = OBJECT_TO_COLUMN[objectName];
	if (!column) return [];
	const sinceMs = Date.now() - maxYears * 365 * 24 * 60 * 60 * 1000;

	const activities = db
		.prepare(
			`SELECT id, name, properties, created_at
			 FROM timeline_activities
			 WHERE ${column} = ?
			   AND created_at >= ?
			 ORDER BY created_at ASC`,
		)
		.all(recordId, sinceMs) as Array<{
		id: string;
		name: string;
		properties: string | null;
		created_at: number;
	}>;

	const externalPrefix = `${objectName}:${recordId}`;
	const documents = db
		.prepare(
			`SELECT id, title, filename, created_at
			 FROM documents
			 WHERE external_id LIKE ?
			   AND created_at >= ?
			 ORDER BY created_at ASC`,
		)
		.all(`${externalPrefix}%`, sinceMs) as Array<{
		id: string;
		title: string;
		filename: string;
		created_at: number;
	}>;

	const entries: TimelineEntry[] = [];
	for (const activity of activities) {
		let body = activity.name;
		try {
			if (activity.properties) {
				const parsed = JSON.parse(activity.properties) as Record<
					string,
					unknown
				>;
				if (typeof parsed.summary === "string") body = parsed.summary;
				else if (typeof parsed.displayText === "string")
					body = parsed.displayText;
			}
		} catch {
			// ignore malformed properties
		}
		entries.push({
			id: activity.id,
			kind: "timeline",
			title: activity.name,
			body,
			occurredAt: activity.created_at,
		});
	}
	for (const doc of documents) {
		entries.push({
			id: doc.id,
			kind: "document",
			title: doc.title,
			body: doc.filename,
			occurredAt: doc.created_at,
		});
	}

	entries.sort((a, b) => a.occurredAt - b.occurredAt);
	return entries;
}
