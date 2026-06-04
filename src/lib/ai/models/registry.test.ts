import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"MOONSHOT_API_KEY",
	"MINIMAX_API_KEY",
] as const;

const original: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of KEYS) original[key] = process.env[key];
	// Isolate from the on-disk dev DB so local keys never interfere.
	process.env.NOLEDGE_DB_PATH = ":memory:";
	vi.resetModules();
});

afterEach(() => {
	for (const key of KEYS) {
		if (original[key] === undefined) delete process.env[key];
		else process.env[key] = original[key];
	}
	delete process.env.NOLEDGE_DB_PATH;
});

async function loadRegistry() {
	return import("./registry");
}

describe("model registry", () => {
	it("includes only providers with a configured key", async () => {
		for (const key of KEYS) delete process.env[key];
		process.env.OPENAI_API_KEY = "sk-test";

		const { availableModels } = await loadRegistry();
		const providers = new Set(availableModels().map((m) => m.provider));
		expect(providers).toEqual(new Set(["openai"]));
	});

	it("resolves a LanguageModel for a configured provider", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const { resolveModel } = await loadRegistry();
		const result = resolveModel("claude-opus-4-8");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.model).toBeDefined();
	});

	it("enables Anthropic thinking for reasoning models", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const { resolveModel } = await loadRegistry();
		const result = resolveModel("claude-opus-4-8");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.reasoning).toBe(true);
			expect(result.providerOptions?.anthropic?.thinking).toEqual({
				type: "enabled",
				budgetTokens: 4096,
			});
		}
	});

	it("enables OpenAI reasoning summaries for reasoning models", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const { resolveModel } = await loadRegistry();
		const result = resolveModel("gpt-5.5");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.reasoning).toBe(true);
			expect(result.providerOptions?.openai?.reasoningSummary).toBe("auto");
		}
	});

	it("enables Kimi thinking by default and can disable it", async () => {
		process.env.MOONSHOT_API_KEY = "sk-kimi-test";
		const { resolveModel } = await loadRegistry();

		const on = resolveModel("kimi-k2.6");
		expect(on.ok).toBe(true);
		if (on.ok) {
			expect(on.reasoning).toBe(true);
			expect(on.providerOptions?.moonshot?.thinking).toEqual({
				type: "enabled",
			});
		}

		// Kimi thinks by default, so disabling must be explicit.
		const off = resolveModel("kimi-k2.6", { thinking: false });
		expect(off.ok).toBe(true);
		if (off.ok) {
			expect(off.providerOptions?.moonshot?.thinking).toEqual({
				type: "disabled",
			});
		}
	});

	it("omits provider options for opt-in reasoning when disabled", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const { resolveModel } = await loadRegistry();
		const off = resolveModel("gpt-5.5", { thinking: false });
		expect(off.ok).toBe(true);
		if (off.ok) expect(off.providerOptions).toBeUndefined();
	});

	it("reports vision support per model", async () => {
		for (const key of KEYS) delete process.env[key];
		process.env.OPENAI_API_KEY = "sk-test";
		process.env.MINIMAX_API_KEY = "sk-minimax-test";
		const { resolveModel } = await loadRegistry();

		const gpt = resolveModel("gpt-5.5");
		expect(gpt.ok && gpt.supportsVision).toBe(true);

		const minimax = resolveModel("MiniMax-M3");
		expect(minimax.ok && minimax.supportsVision).toBe(false);
	});

	it("errors for an unknown model id", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const { resolveModel } = await loadRegistry();
		const result = resolveModel("does-not-exist");
		expect(result.ok).toBe(false);
	});

	it("errors when the provider has no key", async () => {
		for (const key of KEYS) delete process.env[key];
		process.env.OPENAI_API_KEY = "sk-test";
		const { resolveModel } = await loadRegistry();
		const result = resolveModel("claude-opus-4-8");
		expect(result.ok).toBe(false);
	});
});
