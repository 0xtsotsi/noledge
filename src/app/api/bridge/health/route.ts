import { getDatabase } from "@/lib/ai/db/client";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import { errorMessage } from "@/lib/bridge/route-helpers";

export const runtime = "nodejs";

export function GET(request: Request): Response {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	try {
		const db = getDatabase();
		const row = db.prepare("SELECT vec_version() AS version").get() as
			| { version: string }
			| undefined;

		return Response.json({
			ok: true,
			bridge: "ready",
			database: "open",
			sqliteVecVersion: row?.version ?? null,
		});
	} catch (error) {
		return Response.json(
			{
				ok: false,
				bridge: "not_ready",
				error: errorMessage(error, "Noledge bridge health check failed."),
			},
			{ status: 500 },
		);
	}
}
