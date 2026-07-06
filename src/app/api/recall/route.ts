import { z } from "zod";
import { crossMemoryRecall } from "@/lib/ai/search/cross-memory";
import { validateBridgeRequest } from "@/lib/bridge/auth";

export const runtime = "nodejs";

const recallRequestSchema = z.object({
	query: z.string().min(1).max(500),
	topK: z.number().int().min(1).max(20).optional().default(8),
	timeRange: z
		.enum(["day", "week", "month", "year", "all"])
		.optional()
		.default("all"),
	userId: z.string().min(1).optional(),
});

/**
 * POST /api/recall
 * Body: `{ query, topK?, timeRange?, userId? }`.
 *
 * Returns a unified list of memory hits across chat messages, documents, and
 * the per-user `recall_user_context` summaries. The bridge caller (Twenty's
 * `noledge-recall.logic-function.ts`) calls this with the calling user's
 * id so memory is scoped per-user.
 *
 * v1 indexes only the calling user's own data. Cross-user (team-shared)
 * memory is out of scope; see batch3 plan § Feature 5.
 */
export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = recallRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	// Default userId is the bridge caller itself; in single-user Noledge this
	// is fine. Multi-user setups would inject a per-request user from the
	// Twenty JWT.
	const userId = parsed.data.userId ?? "default";
	const hits = await crossMemoryRecall(userId, parsed.data);
	return Response.json({ ok: true, hits, total: hits.length });
}
