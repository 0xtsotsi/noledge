import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";
import { resolveProviderKey } from "./provider-config";
import {
	findModel,
	MODEL_CATALOG,
	type ModelCatalogEntry,
	type ModelId,
	PROVIDER_IDS,
	type ProviderId,
} from "./types";

export type ResolveModelResult =
	| {
			ok: true;
			model: LanguageModel;
			/** Whether the resolved model streams a reasoning trace. */
			reasoning: boolean;
			/** Whether the resolved model accepts native image inputs. */
			supportsVision: boolean;
			/** Provider-specific options (e.g. enabling thinking/reasoning summaries). */
			providerOptions: ProviderOptions | undefined;
	  }
	| { ok: false; error: string };

/** Which providers have an API key configured (local or system). */
function configuredProviders(): Set<ProviderId> {
	const set = new Set<ProviderId>();
	for (const provider of PROVIDER_IDS) {
		if (resolveProviderKey(provider).key) set.add(provider);
	}
	return set;
}

/** Catalog entries whose provider has a configured key. */
export function availableModels(): ModelCatalogEntry[] {
	const providers = configuredProviders();
	return MODEL_CATALOG.filter((entry) => providers.has(entry.provider));
}

/** The default model id, preferring an available provider. */
export function defaultModelId(): ModelId | undefined {
	const available = availableModels();
	return (available.find((entry) => entry.default) ?? available[0])?.id;
}

/**
 * Build provider-specific options for a model's reasoning trace, honoring the
 * user's thinking toggle. Returns undefined when the model has no reasoning
 * capability or when no provider options are needed.
 *
 * - Anthropic: opt-in. `thinking` extended reasoning (budget counts toward
 *   max_tokens; minimum 1024); `sendReasoning` forwards the trace on follow-up
 *   turns. Disabled => omit (the model does not think by default).
 * - OpenAI (Responses API): opt-in. `reasoningSummary: "auto"` streams a
 *   summarized reasoning trace (raw chain-of-thought is never exposed). Disabled
 *   => omit, so no summary is surfaced.
 * - Kimi (Moonshot, OpenAI-compatible): thinking is ON by default, so disabling
 *   MUST send `thinking: { type: "disabled" }` explicitly. The `thinking` field
 *   is passed through to the request body verbatim by the provider.
 */
function reasoningProviderOptions(
	entry: ModelCatalogEntry,
	enabled: boolean,
): ProviderOptions | undefined {
	if (!entry.reasoning) return undefined;
	switch (entry.provider) {
		case "anthropic":
			return enabled
				? {
						anthropic: {
							thinking: { type: "enabled", budgetTokens: 4096 },
							sendReasoning: true,
						},
					}
				: undefined;
		case "openai":
			return enabled
				? {
						openai: {
							reasoningSummary: "auto",
							reasoningEffort: "medium",
						},
					}
				: undefined;
		case "kimi":
			return {
				moonshot: {
					thinking: { type: enabled ? "enabled" : "disabled" },
				},
			};
		default:
			return undefined;
	}
}

function instantiate(entry: ModelCatalogEntry): LanguageModel {
	const apiKey = resolveProviderKey(entry.provider).key;
	switch (entry.provider) {
		case "openai": {
			const openai = createOpenAI({ apiKey });
			return openai(entry.id);
		}
		case "anthropic": {
			const anthropic = createAnthropic({ apiKey });
			return anthropic(entry.id);
		}
		case "kimi": {
			const kimi = createOpenAICompatible({
				name: "moonshot",
				baseURL: "https://api.moonshot.ai/v1",
				apiKey,
			});
			return kimi(entry.id);
		}
		case "minimax": {
			const minimax = createOpenAICompatible({
				name: "minimax",
				baseURL: "https://api.minimax.io/v1",
				apiKey,
			});
			return minimax(entry.id);
		}
	}
}

/**
 * Resolve a model id to an AI SDK `LanguageModel`. Falls back to the default when
 * `id` is undefined. Returns a `Result` for unknown ids or unconfigured providers.
 */
export function resolveModel(
	id?: string,
	opts?: { thinking?: boolean },
): ResolveModelResult {
	const thinkingEnabled = opts?.thinking ?? true;
	const targetId = id ?? defaultModelId();
	if (!targetId) {
		return {
			ok: false,
			error: "No model available — configure at least one provider API key.",
		};
	}

	const entry = findModel(targetId);
	if (!entry) {
		return { ok: false, error: `Unknown model id: ${targetId}` };
	}

	if (!configuredProviders().has(entry.provider)) {
		return {
			ok: false,
			error: `Provider "${entry.provider}" is not configured (missing API key).`,
		};
	}

	return {
		ok: true,
		model: instantiate(entry),
		reasoning: entry.reasoning ?? false,
		supportsVision: entry.vision ?? false,
		providerOptions: reasoningProviderOptions(entry, thinkingEnabled),
	};
}
