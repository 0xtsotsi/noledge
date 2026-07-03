import { z } from "zod";
import { getDatabase } from "@/lib/ai/db/client";
import { retrieveChunks } from "@/lib/ai/rag/retrieve";

/**
 * Cross-account memory search. Fans out to (a) the user's prior chat
 * messages, (b) the ingested documents via the existing RAG retriever,
 * and (c) the per-user `recall_user_context` summary table (one row per
 * chat completion, summarised by `gpt-4o-mini` at persistence time).
 *
 * Returns a unified list of hits sorted by relevance score. Each hit has
 * a `source` discriminator so the front-end can render it differently
 * (chat bubble, document chip, recall summary).
 *
 * The summary step in `persistAssistantTurn` is what populates
 * `recall_user_context` — see `route.ts` in `src/app/api/chat/`.
 */

const crossMemoryHitSchema = z.object({
	source: z.enum(["chat", "document", "recall"]),
	id: z.string(),
	title: z.string(),
	snippet: z.string(),
	score: z.number(),
	createdAt: z.number().optional(),
});

export type CrossMemoryHit = z.infer<typeof crossMemoryHitSchema>;

const recallRequestSchema = z.object({
	query: z.string().min(1),
	topK: z.number().int().min(1).max(20).optional().default(8),
	timeRange: z.enum(["day", "week", "month", "year", "all"]).optional().default("all"),
});

export type RecallRequest = z.infer<typeof recallRequestSchema>;

function timeRangeMs(range: RecallRequest["timeRange"]): number | null {
	if (range === "all") return null;
	const days = { day: 1, week: 7, month: 30, year: 365 } as const;
	return days[range] * 24 * 60 * 60 * 1000;
}

/**
 * Search the user's recall_user_context rows by keyword match on the
 * `query` and `summary` columns. Cheap LIKE-based search — the table is
 * small (one row per chat completion) so we don't bother with FTS5.
 */
function searchRecallContext(
	userId: string,
	query: string,
	sinceMs: number | null,
	topK: number,
): CrossMemoryHit[] {
	try {
		const db = getDatabase();
		const now = Date.now();
		const cutoff = sinceMs !== null ? now - sinceMs : 0;
		const rows = db
			.prepare(
				`SELECT id, query, summary, created_at
				 FROM recall_user_context
				 WHERE user_id = ?
				   AND (query LIKE ? OR summary LIKE ?)
				   AND (? = 0 OR created_at >= ?)
				 ORDER BY created_at DESC
				 LIMIT ?`,
			)
			.all(
				userId,
				`%${query}%`,
				`%${query}%`,
				cutoff,
				cutoff,
				topK,
			) as Array<{
			id: string;
			query: string;
			summary: string;
			created_at: number;
		}>;
		return rows.map((row) => ({
			source: "recall" as const,
			id: row.id,
			title: row.query.slice(0, 80),
			snippet: row.summary,
			score: 0.5,
			createdAt: row.created_at,
		}));
	} catch {
		return [];
	}
}

/**
 * Search the user's prior chat messages by keyword match. Same cheap LIKE
 * approach as `searchRecallContext`. Limits to top-N most recent matches
 * within the time range.
 */
function searchChatMessages(
	userId: string,
	query: string,
	sinceMs: number | null,
	topK: number,
): CrossMemoryHit[] {
	try {
		const db = getDatabase();
		const now = Date.now();
		const cutoff = sinceMs !== null ? now - sinceMs : 0;
		const rows = db
			.prepare(
				`SELECT m.id, m.content, m.created_at
				 FROM conversation_messages m
				 JOIN conversations c ON c.id = m.conversation_id
				 WHERE c.user_id = ?
				   AND m.content LIKE ?
				   AND (? = 0 OR m.created_at >= ?)
				 ORDER BY m.created_at DESC
				 LIMIT ?`,
			)
			.all(userId, `%${query}%`, cutoff, cutoff, topK) as Array<{
			id: string;
			content: string;
			created_at: number;
		}>;
		return rows.map((row) => ({
			source: "chat" as const,
			id: row.id,
			title: row.content.slice(0, 80),
			snippet: row.content.slice(0, 240),
			score: 0.3,
			createdAt: row.created_at,
		}));
	} catch {
		return [];
	}
}

export async function crossMemoryRecall(
	userId: string,
	request: RecallRequest,
): Promise<CrossMemoryHit[]> {
	const topK = request.topK;
	const sinceMs = timeRangeMs(request.timeRange);

	// Fan out to the three sources. Each call is bounded by `topK`; the
	// final merged list is capped at 3 * topK to keep the response small.
	const docHits = await retrieveChunks(request.query, { topK });
	const documents: CrossMemoryHit[] = docHits.ok
		? docHits.chunks.map((chunk) => ({
				source: "document" as const,
				id: chunk.chunkId,
				title: chunk.documentTitle,
				snippet: chunk.content.slice(0, 240),
				score: chunk.score,
			}))
		: [];

	const recallHits = searchRecallContext(userId, request.query, sinceMs, topK);
	const chatHits = searchChatMessages(userId, request.query, sinceMs, topK);

	return [...documents, ...recallHits, ...chatHits]
		.sort((a, b) => b.score - a.score)
		.slice(0, topK * 3);
}