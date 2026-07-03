import {
	kimiCodingHeaders,
	refreshExpiredOAuthCredentials,
} from "@/lib/ai/models/oauth";
import { resolveProviderCredential } from "@/lib/ai/models/provider-config";
import { availableModels } from "@/lib/ai/models/registry";
import { findModel, type ProviderId } from "@/lib/ai/models/types";

type GgProvider = "anthropic" | "openai" | "glm" | "moonshot";

export type ResolvedGgModel = {
	provider: GgProvider;
	model: string;
	apiKey: string;
	baseUrl?: string;
	defaultHeaders?: Record<string, string>;
};

const GG_PROVIDER_MAP: Partial<Record<ProviderId, GgProvider>> = {
	anthropic: "anthropic",
	openai: "openai",
	glm: "glm",
	kimi: "moonshot",
};

export async function resolveGgModel(
	requestedModel?: string,
): Promise<ResolvedGgModel> {
	await refreshExpiredOAuthCredentials();

	const entry = requestedModel
		? findModel(requestedModel)
		: availableModels().find(
				(candidate) => GG_PROVIDER_MAP[candidate.provider],
			);

	if (!entry) {
		if (requestedModel) {
			throw new Error(`Unknown model id: ${requestedModel}`);
		}
		throw new Error(
			"No GG-compatible model is configured. Add OpenAI, Anthropic, GLM, or Kimi credentials in Noledge.",
		);
	}

	const provider = GG_PROVIDER_MAP[entry.provider];
	if (!provider) {
		throw new Error(
			`Provider "${entry.provider}" is not supported by the GG bridge agent yet. Use OpenAI, Anthropic, GLM, or Kimi.`,
		);
	}

	const credential = resolveProviderCredential(entry.provider);
	if (!credential.key) {
		throw new Error(`Provider "${entry.provider}" is not configured.`);
	}

	return {
		provider,
		model: entry.id,
		apiKey: credential.key,
		...(credential.baseURL ? { baseUrl: credential.baseURL } : {}),
		...(entry.provider === "kimi" &&
		credential.baseURL?.includes("api.kimi.com")
			? { defaultHeaders: kimiCodingHeaders() }
			: {}),
	};
}
