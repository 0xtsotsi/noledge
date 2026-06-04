import { afterEach, describe, expect, it, vi } from "vitest";
import type { Innertube } from "youtubei.js";
import { fetchTranscript } from "./transcript";

describe("fetchTranscript", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to InnerTube transcript segments when timedtext is rate limited", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Too Many Requests", { status: 429 })),
		);

		const client = {
			getInfo: async () => ({
				captions: {
					caption_tracks: [
						{
							base_url: "https://example.com/timedtext?v=abc",
							language_code: "en",
						},
					],
				},
				getTranscript: async () => ({
					transcript: {
						content: {
							body: {
								initial_segments: [
									{ snippet: { toString: () => " Hello   world " } },
									{ snippet: { toString: () => "from fallback" } },
								],
							},
						},
					},
				}),
			}),
		} as unknown as Innertube;

		await expect(fetchTranscript("abc", { client })).resolves.toEqual({
			ok: true,
			text: "Hello world\nfrom fallback",
		});
	});

	it("uses InnerTube transcript segments when no timedtext tracks are listed", async () => {
		const client = {
			getInfo: async () => ({
				captions: { caption_tracks: [] },
				getTranscript: async () => ({
					transcript: {
						content: {
							body: {
								initial_segments: [
									{ snippet: { toString: () => "Only fallback" } },
								],
							},
						},
					},
				}),
			}),
		} as unknown as Innertube;

		await expect(fetchTranscript("abc", { client })).resolves.toEqual({
			ok: true,
			text: "Only fallback",
		});
	});
});
