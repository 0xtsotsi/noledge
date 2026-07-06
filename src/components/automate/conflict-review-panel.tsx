import { Check, Warning, X } from "@phosphor-icons/react";
import { revalidatePath } from "next/cache";
import { Button } from "@/components/ui/button";
import { getDatabase } from "@/lib/ai/db/client";

/**
 * Server-rendered review surface for `sync_conflicts` rows. Surfaces every
 * divergent field Google reported vs. the Twenty-side mirror and lets the
 * operator dismiss / accept-local / accept-remote. Resolves via the same code
 * path as `POST /api/bridge/conflicts/[id]/resolve` so the audit trail in
 * `sync_conflicts.resolved_at` is the single source of truth.
 *
 * The panel reads directly from the local SQLite DB — the bridge secret is
 * server-only and can't cross the client boundary, so we keep the read/write
 * on the same runtime as the bridge routes. The bridge route stays as the
 * public API for external callers (e.g. a Twenty CRM script that wants to
 * programmatically resolve a conflict).
 */

export type ConflictReviewItem = {
	id: string;
	provider: string;
	objectName: string;
	recordId: string;
	field: string;
	localValue: string | null;
	remoteValue: string | null;
	detectedAt: number;
};

const PROVIDER_LABEL: Record<string, string> = {
	"google-contacts": "Google Contacts",
};

/**
 * Read unresolved conflicts from the local DB. Keeps the lazy-create
 * defensive shape so a fresh Noledge renders an empty panel rather than 500.
 */
async function listOpenConflicts(
	provider: string,
): Promise<ConflictReviewItem[]> {
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
			detected_at INTEGER NOT NULL,
			resolved_at INTEGER
		)`,
	);
	const rows = db
		.prepare(
			`SELECT id, provider, object_name, record_id, field, local_value, remote_value, detected_at
			 FROM sync_conflicts
			 WHERE provider = ? AND resolved_at IS NULL
			 ORDER BY detected_at DESC
			 LIMIT 100`,
		)
		.all(provider) as Array<{
		id: string;
		provider: string;
		object_name: string;
		record_id: string;
		field: string;
		local_value: string | null;
		remote_value: string | null;
		detected_at: number;
	}>;
	return rows.map((row) => ({
		id: row.id,
		provider: row.provider,
		objectName: row.object_name,
		recordId: row.record_id,
		field: row.field,
		localValue: row.local_value,
		remoteValue: row.remote_value,
		detectedAt: row.detected_at,
	}));
}

/**
 * Server action: marks one conflict as resolved. Mirrors the JSON contract
 * of `/api/bridge/conflicts/[id]/resolve` so the HTTP boundary stays in sync
 * (the action is the UI path, the route is the script path).
 */
async function resolveConflict(
	id: string,
	resolution: "accept_remote" | "accept_local" | "dismiss",
): Promise<void> {
	"use server";
	const db = getDatabase();
	// Defensive lazy-CREATE: keep the 10-column shape (incl. resolved_choice)
	// in lockstep with `ensureSyncConflictsTable` in schema.ts. If a dev
	// boots a brand-new DB without running the migration, this still works.
	db.exec(
		`CREATE TABLE IF NOT EXISTS sync_conflicts (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			object_name TEXT NOT NULL,
			record_id TEXT NOT NULL,
			field TEXT NOT NULL,
			local_value TEXT,
			remote_value TEXT,
			detected_at INTEGER NOT NULL,
			resolved_at INTEGER,
			resolved_choice TEXT
		)`,
	);
	// Map the UI's three-way picker to the audit-friendly value stored on
	// the row. `dismiss` keeps the audit trail but records no winner.
	const resolvedChoice =
		resolution === "accept_remote"
			? "remote"
			: resolution === "accept_local"
				? "local"
				: null;
	db.prepare(
		"UPDATE sync_conflicts SET resolved_at = ?, resolved_choice = ? WHERE id = ? AND resolved_at IS NULL",
	).run(Date.now(), resolvedChoice, id);
	// Either way, revalidate so the panel re-renders without the row. A
	// no-op here (already-resolved or missing) is silent on purpose — the
	// action lives on the server and can't call client-only `sonner`.
	revalidatePath("/automate");
}

function FieldDiff({
	label,
	localValue,
	remoteValue,
}: {
	label: string;
	localValue: string | null;
	remoteValue: string | null;
}): React.JSX.Element {
	return (
		<div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-xs">
			<span className="font-medium uppercase tracking-wide text-muted-foreground">
				{label}
			</span>
			<div className="flex flex-col gap-1">
				<span className="rounded bg-muted px-2 py-1 font-mono">
					local: {localValue ?? "—"}
				</span>
				<span className="rounded bg-muted px-2 py-1 font-mono">
					remote: {remoteValue ?? "—"}
				</span>
			</div>
		</div>
	);
}

function ConflictRow({
	conflict,
}: {
	conflict: ConflictReviewItem;
}): React.JSX.Element {
	return (
		<li className="flex flex-col gap-3 rounded-lg border p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex flex-col gap-0.5">
					<span className="font-mono text-xs text-muted-foreground">
						{conflict.recordId}
					</span>
					<span className="text-xs text-muted-foreground">
						{PROVIDER_LABEL[conflict.provider] ?? conflict.provider} ·{" "}
						{new Date(conflict.detectedAt).toLocaleString()}
					</span>
				</div>
			</div>
			<FieldDiff
				label={conflict.field}
				localValue={conflict.localValue}
				remoteValue={conflict.remoteValue}
			/>
			<div className="flex flex-wrap gap-2">
				<form action={resolveConflict.bind(null, conflict.id, "accept_remote")}>
					<Button size="sm" variant="default">
						<Check className="size-3.5" />
						Accept remote
					</Button>
				</form>
				<form action={resolveConflict.bind(null, conflict.id, "accept_local")}>
					<Button size="sm" variant="outline">
						<Check className="size-3.5" />
						Keep local
					</Button>
				</form>
				<form action={resolveConflict.bind(null, conflict.id, "dismiss")}>
					<Button size="sm" variant="ghost">
						<X className="size-3.5" />
						Dismiss
					</Button>
				</form>
			</div>
		</li>
	);
}

export async function ConflictReviewPanel({
	provider = "google-contacts",
}: {
	provider?: string;
} = {}): Promise<React.JSX.Element> {
	const conflicts = await listOpenConflicts(provider);
	if (conflicts.length === 0) {
		return (
			<section className="flex animate-rise-in flex-col gap-2 rounded-xl border p-5">
				<div className="flex items-center gap-2">
					<Check className="size-4 text-emerald-600" />
					<h2 className="text-sm font-semibold">Sync conflicts</h2>
				</div>
				<p className="text-xs text-muted-foreground">
					No divergent fields. The next sync will surface anything new here.
				</p>
			</section>
		);
	}
	return (
		<section className="flex animate-rise-in flex-col gap-3 rounded-xl border p-5">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Warning className="size-4 text-amber-600" />
					<h2 className="text-sm font-semibold">Sync conflicts</h2>
					<span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900 dark:text-amber-200">
						{conflicts.length} open
					</span>
				</div>
			</div>
			<p className="text-xs text-muted-foreground">
				These fields differ between {PROVIDER_LABEL[provider] ?? provider} and
				the local mirror. Pick the value you want to keep; the loser is archived
				in the audit trail.
			</p>
			<ul className="flex flex-col gap-3">
				{conflicts.map((c) => (
					<ConflictRow key={c.id} conflict={c} />
				))}
			</ul>
		</section>
	);
}
