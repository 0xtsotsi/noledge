import type { Database } from "better-sqlite3";
import { getDatabase } from "@/lib/ai/db/client";

export type RecentDocument = {
	id: string;
	title: string;
	sourceUrl?: string;
	documentDate: number;
	createdAt: number;
};

export function listRecentDocuments(
	limit = 5,
	db: Database = getDatabase(),
): RecentDocument[] {
	const safeLimit = Math.max(1, Math.min(limit, 10));
	const rows = db
		.prepare(
			`SELECT
				id,
				title,
				source_url,
				COALESCE(published_at, created_at) AS document_date,
				created_at
			FROM documents
			ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC
			LIMIT ?`,
		)
		.all(safeLimit) as {
		id: string;
		title: string;
		source_url: string | null;
		document_date: number;
		created_at: number;
	}[];

	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		...(row.source_url ? { sourceUrl: row.source_url } : {}),
		documentDate: row.document_date,
		createdAt: row.created_at,
	}));
}
