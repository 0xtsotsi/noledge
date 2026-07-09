import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/ai/env";

export const NOLEDGE_BRIDGE_SECRET_HEADER = "x-noledge-bridge-secret";

export type BridgeAuthResult = { ok: true } | { ok: false; response: Response };

function unauthorized(message: string): Response {
	return Response.json({ ok: false, error: message }, { status: 401 });
}

/**
 * BP-001 (2026-07-06): use timingSafeEqual after a length-equality branch.
 * Plain `!==` short-circuits at the first mismatched byte, which leaks a
 * microsecond-scale timing oracle to a high-throughput LAN attacker. The
 * length-equality check is intentionally coarse (it does leak the expected
 * length, but the secret is held to >= 32 chars by getEnv(), so the
 * information leak is negligible).
 */
function secretsMatch(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
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
	if (!providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
		return {
			ok: false,
			response: unauthorized("Invalid Noledge bridge secret."),
		};
	}

	return { ok: true };
}
