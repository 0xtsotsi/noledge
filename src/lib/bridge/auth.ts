import { getEnv } from "@/lib/ai/env";

export const NOLEDGE_BRIDGE_SECRET_HEADER = "x-noledge-bridge-secret";

export type BridgeAuthResult = { ok: true } | { ok: false; response: Response };

function unauthorized(message: string): Response {
	return Response.json({ ok: false, error: message }, { status: 401 });
}

export function validateBridgeRequest(request: Request): BridgeAuthResult {
	const expectedSecret = getEnv().NOLEDGE_BRIDGE_SECRET;
	if (!expectedSecret) {
		return {
			ok: false,
			response: unauthorized("Noledge bridge secret is not configured."),
		};
	}

	const providedSecret = request.headers.get(NOLEDGE_BRIDGE_SECRET_HEADER);
	if (providedSecret !== expectedSecret) {
		return {
			ok: false,
			response: unauthorized("Invalid Noledge bridge secret."),
		};
	}

	return { ok: true };
}
