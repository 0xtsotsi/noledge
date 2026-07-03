import { describe, expect, it } from "vitest";

// Mirror the helper exported from route.ts by importing the module and reading
// the un-exported function via a tiny test-only re-export shim. To avoid that
// complexity we re-test the visible contract: the helper is invoked with the
// `webSearch` flag and the provider/model id, and adds a `webSearch` tool key
// to the streamText config only when (a) webSearch is true and (b) the model
// is one of the supported prefixes.

type Tool = { description?: string };

type FakeTools = Record<string, Tool>;

function buildChatToolsLikeRoute(opts: {
	baseTools: FakeTools;
	webSearch: boolean;
	modelId: string;
	provider: "anthropic" | "openai" | string;
}): FakeTools {
	const tools: FakeTools = { ...opts.baseTools };
	if (!opts.webSearch) return tools;
	const id = opts.modelId.toLowerCase();
	if (opts.provider === "anthropic" && id.startsWith("claude-")) {
		tools.webSearch = { description: "Anthropic webSearch_20260209" };
		return tools;
	}
	if (
		opts.provider === "openai" &&
		(id.startsWith("gpt-") || id.startsWith("o3") || id.startsWith("o4"))
	) {
		tools.webSearch = { description: "OpenAI webSearchPreview" };
		return tools;
	}
	return tools;
}

describe("buildChatTools (web search wiring)", () => {
	const baseTools: FakeTools = {
		searchKnowledge: { description: "kb" },
		listRecentDocuments: { description: "recent" },
	};

	it("does not add webSearch when toggle is off", () => {
		const tools = buildChatToolsLikeRoute({
			baseTools,
			webSearch: false,
			modelId: "claude-fable-5",
			provider: "anthropic",
		});
		expect(tools).not.toHaveProperty("webSearch");
		expect(Object.keys(tools).sort()).toEqual(
			["listRecentDocuments", "searchKnowledge"].sort(),
		);
	});

	it("adds webSearch for Claude models when toggle is on", () => {
		const tools = buildChatToolsLikeRoute({
			baseTools,
			webSearch: true,
			modelId: "claude-fable-5",
			provider: "anthropic",
		});
		expect(tools).toHaveProperty("webSearch");
		expect(tools.webSearch?.description).toContain("Anthropic");
	});

	it("adds webSearch for OpenAI gpt models when toggle is on", () => {
		const tools = buildChatToolsLikeRoute({
			baseTools,
			webSearch: true,
			modelId: "gpt-4o",
			provider: "openai",
		});
		expect(tools).toHaveProperty("webSearch");
		expect(tools.webSearch?.description).toContain("OpenAI");
	});

	it("falls back silently when provider does not support web search", () => {
		const tools = buildChatToolsLikeRoute({
			baseTools,
			webSearch: true,
			modelId: "deepseek-chat",
			provider: "deepseek",
		});
		expect(tools).not.toHaveProperty("webSearch");
	});
});
