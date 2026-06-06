import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTranscript } from "./transcript";

vi.mock("youtube-transcript-plus", () => ({
	fetchTranscript: vi.fn(),
	FsCache: class {},
}));

vi.mock("./ytdlp", () => ({
	fetchTranscriptViaYtdlp: vi.fn(),
}));

const { fetchTranscript: mockYtFetch } = await import(
	"youtube-transcript-plus"
);
const { fetchTranscriptViaYtdlp: mockYtdlp } = await import("./ytdlp");

describe("fetchTranscript", () => {
	afterEach(() => {
		vi.mocked(mockYtFetch).mockReset();
		vi.mocked(mockYtdlp).mockReset();
	});

	it("returns text from youtube-transcript-plus when it succeeds", async () => {
		vi.mocked(mockYtFetch).mockResolvedValue([
			{ text: "Hello", offset: 0, duration: 1, lang: "en" },
			{ text: "world", offset: 1, duration: 1, lang: "en" },
		]);

		await expect(fetchTranscript("abc")).resolves.toEqual({
			ok: true,
			text: "Hello\nworld",
		});
	});

	it("falls back to yt-dlp when youtube-transcript-plus throws", async () => {
		vi.mocked(mockYtFetch).mockRejectedValue(new Error("Too Many Requests"));
		vi.mocked(mockYtdlp).mockResolvedValue({
			ok: true,
			text: "From yt-dlp",
		});

		await expect(fetchTranscript("abc")).resolves.toEqual({
			ok: true,
			text: "From yt-dlp",
		});
	});

	it("returns skip when both paths fail", async () => {
		vi.mocked(mockYtFetch).mockRejectedValue(new Error("rate limited"));
		vi.mocked(mockYtdlp).mockResolvedValue({
			ok: false,
			skipped: true,
			reason: "yt-dlp failed: 429",
		});

		await expect(fetchTranscript("abc")).resolves.toEqual({
			ok: false,
			skipped: true,
			reason: "yt-dlp failed: 429",
		});
	});

	it("passes language option through", async () => {
		vi.mocked(mockYtFetch).mockResolvedValue([
			{ text: "Bonjour", offset: 0, duration: 1, lang: "fr" },
		]);

		await expect(fetchTranscript("abc", { language: "fr" })).resolves.toEqual({
			ok: true,
			text: "Bonjour",
		});

		expect(mockYtFetch).toHaveBeenCalledWith("abc", {
			lang: "fr",
			retries: 3,
			retryDelay: 2000,
			cache: expect.anything(),
		});
	});
});
