import { validateBridgeRequest } from "@/lib/bridge/auth";
import {
	errorMessage,
	invalidJsonResponse,
	validationErrorResponse,
} from "@/lib/bridge/route-helpers";
import { bridgeAgentRequestSchema } from "@/lib/bridge/schemas";
import { runNoledgeAgent } from "@/lib/gg/noledge-agent";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return invalidJsonResponse();
	}

	const parsed = bridgeAgentRequestSchema.safeParse(raw);
	if (!parsed.success) return validationErrorResponse(parsed.error);

	try {
		const result = await runNoledgeAgent(parsed.data, request.signal);
		return Response.json(result, { status: result.ok ? 200 : 422 });
	} catch (error) {
		return Response.json(
			{
				ok: false,
				error: errorMessage(error, "Noledge bridge agent failed."),
				sources: [],
				steps: [],
			},
			{ status: 500 },
		);
	}
}
