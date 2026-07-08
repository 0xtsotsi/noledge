import path from "node:path";
import { z } from "zod";

/**
 * Server-side environment configuration for the AI + RAG stack.
 *
 * API keys are optional: a provider whose key is absent is filtered out of the
 * model registry/catalog rather than crashing the app at boot. OCR settings have
 * sensible defaults.
 */

// BP-001 (2026-07-06): reject well-known weak defaults so an operator who
// copies a shipped .env.local can't accidentally expose the bridge surface.
const BRIDGE_SECRET_BAD_DEFAULTS = new Set([
	"noledge-secret-67890",
	"changeme",
	"change-me",
	"secret",
	"password",
	"test",
	"dev",
	"local",
	"default",
	"bridge-secret",
	"noledge-bridge-secret",
	"12345",
	"1234567890",
	"abc123",
]);

const MIN_BRIDGE_SECRET_LENGTH = 32;

/**
 * BP-001: returns the value iff it is >= MIN_BRIDGE_SECRET_LENGTH chars AND
 * not in the deny-list. Returns undefined otherwise (so the app boots but
 * bridge routes 401). Exported for testing.
 */
export function coerceBridgeSecret(
	raw: string | undefined,
): string | undefined {
	if (!raw) return undefined;
	if (raw.length < MIN_BRIDGE_SECRET_LENGTH) return undefined;
	if (BRIDGE_SECRET_BAD_DEFAULTS.has(raw.toLowerCase())) return undefined;
	return raw;
}

const envSchema = z.object({
	OPENAI_API_KEY: z.string().min(1).optional(),
	ANTHROPIC_API_KEY: z.string().min(1).optional(),
	GEMINI_API_KEY: z.string().min(1).optional(),
	MOONSHOT_API_KEY: z.string().min(1).optional(),
	GLM_API_KEY: z.string().min(1).optional(),
	MINIMAX_API_KEY: z.string().min(1).optional(),
	XIAOMI_API_KEY: z.string().min(1).optional(),
	DEEPSEEK_API_KEY: z.string().min(1).optional(),
	OPENROUTER_API_KEY: z.string().min(1).optional(),
	// BP-001: validated separately via coerceBridgeSecret so a weak/missing
	// value doesn't crash boot — the app still serves the local chat UI, but
	// bridge routes 401 until the operator sets a strong secret.
	NOLEDGE_BRIDGE_SECRET: z.string().min(1).optional(),
	// Audit 2026-07-06 B12: TWENTY_BASE_URL controls how noledge links back to
	// Twenty records. Default to localhost:2020 (the Twenty dev port) so existing
	// local setups keep working. If the env var is set to garbage, fall back
	// to the default rather than crashing every route that uses getEnv().
	TWENTY_BASE_URL: z
		.string()
		.default("http://localhost:2020")
		.transform((value) => {
			try {
				return new URL(value).toString().replace(/\/$/, "");
			} catch {
				return "http://localhost:2020";
			}
		}),
	OCR_ENABLED: z
		.enum(["true", "false"])

		.default("true")
		.transform((value) => value === "true"),
	OCR_LANGUAGE: z.string().min(1).default("eng"),
});

export type AiEnv = z.infer<typeof envSchema> & {
	readonly dbPath: string;
};

let cached: AiEnv | null = null;
let warnedMissingBridgeSecret = false;

/** Parse and cache the validated server environment. */
export function getEnv(): AiEnv {
	if (cached) return cached;

	const parsed = envSchema.parse({
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
		GLM_API_KEY: process.env.GLM_API_KEY,
		MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
		XIAOMI_API_KEY: process.env.XIAOMI_API_KEY,
		DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
		OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
		NOLEDGE_BRIDGE_SECRET: process.env.NOLEDGE_BRIDGE_SECRET,
		TWENTY_BASE_URL: process.env.TWENTY_BASE_URL,
		OCR_ENABLED: process.env.OCR_ENABLED,
		OCR_LANGUAGE: process.env.OCR_LANGUAGE,
	});

	// BP-001: drop the secret if it's too short or matches a known weak default.
	// Done at construction so an invalid value doesn't crash boot.
	const coerced = coerceBridgeSecret(parsed.NOLEDGE_BRIDGE_SECRET);

	cached = {
		...parsed,
		NOLEDGE_BRIDGE_SECRET: coerced,
		dbPath:
			process.env.NOLEDGE_DB_PATH ??
			path.join(process.cwd(), ".data", "noledge.db"),
	};

	// BP-001: warn loudly if no usable bridge secret is configured. Every
	// /api/bridge/* request will 401 until this is set, and the MCP endpoint
	// is unreachable. Don't crash — the app can still serve the local chat UI.
	if (!cached.NOLEDGE_BRIDGE_SECRET && !warnedMissingBridgeSecret) {
		warnedMissingBridgeSecret = true;
		console.warn(
			"[noledge] NOLEDGE_BRIDGE_SECRET is missing, too short (<32 chars), or matches a known-weak default. " +
				"/api/bridge/*, /api/mcp, and /api/recall will reject all requests. " +
				"Generate a strong secret with `openssl rand -hex 32` and set it in .env.local.",
		);
	}

	return cached;
}
