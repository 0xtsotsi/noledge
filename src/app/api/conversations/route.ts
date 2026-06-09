import { getDatabase } from "@/lib/ai/db/client";

type ConversationRow = {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
};

export async function GET(): Promise<Response> {
	const db = getDatabase();
	const rows = db
		.prepare(
			"SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 100",
		)
		.all() as ConversationRow[];

	return Response.json({
		conversations: rows.map((row) => ({
			id: row.id,
			title: row.title,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		})),
	});
}
