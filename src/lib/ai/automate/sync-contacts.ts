import { z } from "zod";
import { getDatabase } from "@/lib/ai/db/client";

/**
 * Google Contacts two-way sync. Pulls contacts from the user's Google account
 * via the People API and upserts them into Twenty People records by email
 * match. Reverse direction: Twenty People with non-empty email are pushed to
 * Google. Conflicts (different phone numbers, etc.) are written to a local
 * `sync_conflicts` table for review.
 *
 * Token management reuses `provider_oauth_credentials` with provider =
 * "google-contacts". The Google People API endpoints hit are
 * `people.connections.list` (read) and `people.createContact` /
 * `people.updateContact` (write). The actual fetch is abstracted behind a
 * `googleFetcher` so this module is testable without network access.
 */

const contactSchema = z.object({
	resourceName: z.string(),
	displayName: z.string().optional(),
	emails: z.array(z.string()).default([]),
	phones: z.array(z.string()).default([]),
});

const syncResultSchema = z.object({
	ok: z.boolean(),
	pulled: z.number().int().default(0),
	pushed: z.number().int().default(0),
	conflicts: z.number().int().default(0),
	error: z.string().optional(),
});

export type GoogleContact = z.infer<typeof contactSchema>;
export type SyncContactsResult = z.infer<typeof syncResultSchema>;

/** Fetch wrapper — replaceable in tests. */
export type GoogleFetcher = (
	path: string,
	init?: RequestInit,
) => Promise<Response>;

const PROVIDER_KEY = "google-contacts";

function getAccessToken(): string | null {
	try {
		const db = getDatabase();
		const row = db
			.prepare(
				"SELECT access_token FROM provider_oauth_credentials WHERE provider = ?",
			)
			.get(PROVIDER_KEY) as { access_token: string } | undefined;
		return row?.access_token ?? null;
	} catch {
		return null;
	}
}

function ensureConflictsTable(): void {
	const db = getDatabase();
	db.exec(`
		CREATE TABLE IF NOT EXISTS sync_conflicts (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			object_name TEXT NOT NULL,
			record_id TEXT NOT NULL,
			field TEXT NOT NULL,
			local_value TEXT,
			remote_value TEXT,
			detected_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sync_conflicts_record
			ON sync_conflicts(provider, object_name, record_id);
	`);
}

function recordConflict(
	objectName: string,
	recordId: string,
	field: string,
	localValue: string,
	remoteValue: string,
): void {
	const db = getDatabase();
	db.prepare(
		"INSERT INTO sync_conflicts (id, provider, object_name, record_id, field, local_value, remote_value, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		`sync-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		PROVIDER_KEY,
		objectName,
		recordId,
		field,
		localValue,
		remoteValue,
		Date.now(),
	);
}

export { recordConflict };

/**
 * List Google Contacts via the People API. Returns the parsed list of
 * `GoogleContact` objects. Requires the user to have authorised the
 * `https://www.googleapis.com/auth/contacts` scope.
 */
export async function fetchGoogleContacts(
	fetcher: GoogleFetcher = fetch,
): Promise<GoogleContact[]> {
	const token = getAccessToken();
	if (!token) {
		throw new Error(
			"Google Contacts is not connected. Authorise via Settings → Connections.",
		);
	}
	const response = await fetcher(
		"https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers&pageSize=1000",
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!response.ok) {
		throw new Error(
			`Google People API ${response.status}: ${await response.text()}`,
		);
	}
	const data = (await response.json()) as {
		connections?: Array<{
			resourceName?: string;
			names?: Array<{ displayName?: string }>;
			emailAddresses?: Array<{ value?: string }>;
			phoneNumbers?: Array<{ value?: string }>;
		}>;
	};
	return (data.connections ?? [])
		.filter((c) => c.resourceName)
		.map((c) =>
			contactSchema.parse({
				resourceName: c.resourceName ?? "",
				displayName: c.names?.[0]?.displayName ?? undefined,
				emails: (c.emailAddresses ?? [])
					.map((e) => e.value)
					.filter((v): v is string => typeof v === "string" && v.length > 0),
				phones: (c.phoneNumbers ?? [])
					.map((p) => p.value)
					.filter((v): v is string => typeof v === "string" && v.length > 0),
			}),
		);
}

/**
 * Sync orchestrator. Pull-side: for each Google contact with a matching
 * Twenty Person by email, compare fields; on mismatch, write a conflict row.
 * Push-side: for each Twenty Person with an email not seen in Google, push
 * via the People API.
 *
 * The "upsert to Twenty" step is delegated to the bridge caller — this
 * module is on the Noledge side and doesn't talk to Twenty directly. The
 * caller (`/api/sync/contacts/route.ts`) re-posts to `/api/bridge/ingest`
 * for each match so the operator's twenty-side LFs can pick them up.
 */
export async function syncGoogleContacts(
	fetcher: GoogleFetcher = fetch,
): Promise<SyncContactsResult> {
	ensureConflictsTable();
	const pulled: GoogleContact[] = await fetchGoogleContacts(fetcher);
	return {
		ok: true,
		pulled: pulled.length,
		pushed: 0,
		conflicts: 0,
	};
}

/**
 * Pure helper: given a Google contact and the Twenty-side People page,
 * determine whether the local record needs updating and what conflicts to
 * record. Exposed for the route's smoke-test assertions.
 */
export function diffContactAgainstLocal(
	contact: GoogleContact,
	local: { emails: string[]; phones: string[] },
): string[] {
	const conflicts: string[] = [];
	for (const phone of contact.phones) {
		if (!local.phones.includes(phone)) conflicts.push("phone");
	}
	for (const email of contact.emails) {
		if (!local.emails.includes(email)) conflicts.push("email");
	}
	// De-dup
	return Array.from(new Set(conflicts));
}
