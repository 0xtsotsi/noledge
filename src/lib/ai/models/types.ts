/**
 * Central model catalog. Every model id the app can use lives here so version
 * bumps (providers iterate fast) are a one-line change rather than scattered
 * string literals across routes.
 */

export const PROVIDER_IDS = [
	"anthropic",
	"openai",
	"gemini",
	"kimi",
	"glm",
	"minimax",
	"xiaomi",
	"deepseek",
	"openrouter",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ModelCatalogEntry = {
	id: string;
	provider: ProviderId;
	label: string;
	/** Default model id for the provider (sent when no model is specified). */
	default: boolean;
	/**
	 * Whether this model exposes a reasoning / thinking trace. When true the chat
	 * route enables provider-specific reasoning and streams the trace to the UI.
	 */
	reasoning?: boolean;
	/**
	 * Whether this model accepts image inputs. When true, image attachments are
	 * forwarded to the model as native image parts; otherwise they are OCR'd to
	 * text server-side so even text-only models receive their content.
	 */
	vision?: boolean;
	/**
	 * Whether the provider accepts PDF documents natively as file parts. When
	 * true, PDF attachments are forwarded verbatim instead of being extracted to
	 * text server-side.
	 */
	pdf?: boolean;
};

/**
 * Default model ids per provider (verified June 2026). Override via env if a
 * provider ships a newer snapshot.
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
	// Anthropic
	{
		id: "claude-fable-5",
		provider: "anthropic",
		label: "Claude Fable 5",
		default: false,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	{
		id: "claude-opus-4-8",
		provider: "anthropic",
		label: "Claude Opus 4.8",
		default: true,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	{
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		label: "Claude Sonnet 4.6",
		default: false,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	{
		id: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		label: "Claude Haiku 4.5",
		default: false,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	// OpenAI / Codex family
	{
		id: "gpt-5.5",
		provider: "openai",
		label: "GPT-5.5",
		default: true,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	{
		id: "gpt-5.4",
		provider: "openai",
		label: "GPT-5.4",
		default: false,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	{
		id: "gpt-5.4-mini",
		provider: "openai",
		label: "GPT-5.4 Mini",
		default: false,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	{
		id: "gpt-5.3-codex",
		provider: "openai",
		label: "GPT-5.3 Codex",
		default: false,
		reasoning: true,
		vision: true,
		pdf: true,
	},
	// Gemini (OpenAI-compatible endpoint)
	{
		id: "gemini-3.1-flash-lite-preview",
		provider: "gemini",
		label: "Gemini 3.1 Flash Lite Preview",
		default: true,
		reasoning: true,
		vision: true,
	},
	{
		id: "gemini-3.5-flash",
		provider: "gemini",
		label: "Gemini 3.5 Flash",
		default: false,
		reasoning: true,
		vision: true,
	},
	// Moonshot (Kimi)
	{
		id: "kimi-k2.6",
		provider: "kimi",
		label: "Kimi K2.6",
		default: true,
		reasoning: true,
		// Native multimodal (MoonViT vision encoder); the Moonshot OpenAI-compatible
		// API accepts image inputs as `image_url` content parts.
		vision: true,
	},
	// Z.AI (GLM)
	{
		id: "glm-5.1",
		provider: "glm",
		label: "GLM-5.1",
		default: true,
		reasoning: true,
	},
	{
		id: "glm-4.7",
		provider: "glm",
		label: "GLM-4.7",
		default: false,
		reasoning: true,
	},
	{
		id: "glm-4.7-flash",
		provider: "glm",
		label: "GLM-4.7 Flash",
		default: false,
		reasoning: true,
	},
	// MiniMax
	{
		id: "MiniMax-M3",
		provider: "minimax",
		label: "MiniMax M3",
		default: true,
		reasoning: true,
		vision: true,
	},
	// Xiaomi (MiMo)
	{
		id: "mimo-v2.5-pro",
		provider: "xiaomi",
		label: "MiMo-V2.5-Pro",
		default: true,
		reasoning: true,
	},
	{
		id: "mimo-v2.5",
		provider: "xiaomi",
		label: "MiMo-V2.5",
		default: false,
		reasoning: true,
		vision: true,
	},
	// DeepSeek
	{
		id: "deepseek-v4-pro",
		provider: "deepseek",
		label: "DeepSeek V4 Pro",
		default: true,
		reasoning: true,
	},
	{
		id: "deepseek-v4-flash",
		provider: "deepseek",
		label: "DeepSeek V4 Flash",
		default: false,
		reasoning: true,
	},
	// OpenRouter
	{
		id: "qwen/qwen3.6-plus",
		provider: "openrouter",
		label: "Qwen3.6-Plus",
		default: true,
		reasoning: true,
	},
] as const;

export type ModelId = (typeof MODEL_CATALOG)[number]["id"];

const MODEL_IDS = new Set(MODEL_CATALOG.map((entry) => entry.id));

/** Narrow an arbitrary string to a known catalog model id. */
export function isModelId(value: string): value is ModelId {
	return MODEL_IDS.has(value);
}

/** Look up the catalog entry for a model id, if known. */
export function findModel(id: string): ModelCatalogEntry | undefined {
	return MODEL_CATALOG.find((entry) => entry.id === id);
}
