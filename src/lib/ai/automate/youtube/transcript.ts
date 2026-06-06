import {
	type FetchParams,
	FsCache,
	type TranscriptSegment,
	fetchTranscript as ytFetchTranscript,
} from "youtube-transcript-plus";
import { fetchTranscriptViaYtdlp } from "./ytdlp";

/**
 * YouTube transcript fetcher. Two independent paths, both avoiding the
 * unreliable `info.getTranscript()` endpoint (YouTube.js #1102):
 *
 *  1. `youtube-transcript-plus` — uses the ANDROID InnerTube client for
 *     caption tracks, with built-in retry + exponential backoff for 429s and
 *     filesystem caching so repeat requests are instant.
 *  2. yt-dlp — shells out to the yt-dlp binary as a fallback.
 *
 * Both paths hit YouTube's `timedtext` endpoint for the actual transcript
 * data, which is subject to IP-level 429s. The filesystem cache on path 1
 * means a video only needs to succeed once; subsequent requests are served
 * from disk.
 *
 * Set `HTTPS_PROXY` or `HTTP_PROXY` to route requests through a proxy,
 * which bypasses IP-level rate limits.
 *
 * Every failure is reported as a **skip with a reason** rather than thrown.
 * The module is swappable: a paid transcript API could replace
 * {@link fetchTranscript} without touching the poller.
 */

export type TranscriptResult =
	| { ok: true; text: string }
	| { ok: false; skipped: true; reason: string };

/** Filesystem cache for transcripts — persists across restarts. */
const transcriptCache = new FsCache(
	".cache/youtube-transcripts",
	7 * 86_400_000,
); // 7 days

/** Resolve proxy URL from environment, if set. */
function proxyUrl(): string | undefined {
	return (
		process.env.HTTPS_PROXY ??
		process.env.HTTP_PROXY ??
		process.env.https_proxy ??
		process.env.http_proxy
	);
}

function segmentsToText(segments: TranscriptSegment[]): string {
	return segments
		.map((seg) => seg.text.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

/**
 * Build a proxy-dispatching fetch if `HTTPS_PROXY` / `HTTP_PROXY` is set.
 * Returns `undefined` when no proxy is configured (library uses default fetch).
 */
async function proxyFetch(): Promise<
	| {
			videoFetch: (params: FetchParams) => Promise<Response>;
			playerFetch: (params: FetchParams) => Promise<Response>;
			transcriptFetch: (params: FetchParams) => Promise<Response>;
	  }
	| undefined
> {
	const proxy = proxyUrl();
	if (!proxy) return undefined;

	const { ProxyAgent, fetch: undiciFetch } = await import("undici");
	const agent = new ProxyAgent(proxy);

	const proxyFetchFn = async (params: FetchParams): Promise<Response> => {
		return undiciFetch(params.url, {
			method: (params.method ?? "GET") as "GET" | "POST",
			headers: {
				...params.headers,
				...(params.lang && { "Accept-Language": params.lang }),
				...(params.userAgent && { "User-Agent": params.userAgent }),
			},
			body: params.body,
			signal: params.signal,
			dispatcher: agent,
		}) as unknown as Promise<Response>;
	};

	return {
		videoFetch: proxyFetchFn,
		playerFetch: proxyFetchFn,
		transcriptFetch: proxyFetchFn,
	};
}

/**
 * Fetch a transcript for `videoId`. Returns the joined caption text, or a skip
 * with a human-readable reason when captions are unavailable or YouTube blocks
 * the request. Never throws on network/format failures.
 *
 * Fetch order:
 *  1. youtube-transcript-plus (ANDROID client, retry, filesystem cache)
 *  2. yt-dlp (shells out, no caching)
 */
export async function fetchTranscript(
	videoId: string,
	options: { language?: string } = {},
): Promise<TranscriptResult> {
	const lang = options.language ?? "en";
	const proxy = await proxyFetch();

	// 1. Primary: youtube-transcript-plus with retry + cache.
	try {
		const segments = await ytFetchTranscript(videoId, {
			lang,
			retries: 3,
			retryDelay: 2000,
			cache: transcriptCache,
			...proxy,
		});
		const text = segmentsToText(segments);
		if (text.trim().length === 0) {
			return { ok: false, skipped: true, reason: "Transcript was empty." };
		}
		return { ok: true, text };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "Unknown error.";
		console.warn(
			`[transcript] youtube-transcript-plus failed for ${videoId}: ${reason}`,
		);
		// Fall through to yt-dlp.
	}

	// 2. Fallback: yt-dlp.
	return fetchTranscriptViaYtdlp(videoId, lang, proxyUrl());
}
