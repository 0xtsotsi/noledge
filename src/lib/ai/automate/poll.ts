import type { Database } from "better-sqlite3";
import { getDatabase } from "@/lib/ai/db/client";
import { embedTexts } from "@/lib/ai/embeddings/embed";
import { resolveProviderKey } from "@/lib/ai/models/provider-config";
import { extractText } from "@/lib/ai/rag/extract";
import type { Embedder } from "@/lib/ai/rag/ingest";
import { ingestText } from "@/lib/ai/rag/ingest";
import { getPaperProvider, isPaperType } from "./papers";
import { httpBinary } from "./papers/http";
import { fetchArticleText } from "./rss/article";
import { fetchFeed } from "./rss/parse";
import {
	type AutomationSource,
	documentExists,
	listEnabledSources,
	setLastRunAt,
	setSourceHttpCache,
	updateSourceStatus,
} from "./store";
import {
	fetchTranscript as defaultFetchTranscript,
	type TranscriptResult,
} from "./youtube/transcript";
import {
	listRecentVideos as defaultListRecentVideos,
	type ListVideosResult,
} from "./youtube/videos";

/** Injectable fetch for RSS feeds (tests). */
type FetchFn = typeof fetch;

/**
 * YouTube discovery + transcript operations, injectable so tests can supply fakes
 * without standing up the InnerTube client / mocking its protocol.
 */
export type YoutubeDeps = {
	listVideos: (channelId: string, limit: number) => Promise<ListVideosResult>;
	fetchTranscript: (videoId: string) => Promise<TranscriptResult>;
};

const defaultYoutubeDeps: YoutubeDeps = {
	listVideos: (channelId, limit) => defaultListRecentVideos(channelId, limit),
	fetchTranscript: (videoId) => defaultFetchTranscript(videoId),
};

/**
 * The poller: for each enabled source, discover candidate items, skip anything
 * already ingested (`documentExists`), fetch text/transcript, and feed it through
 * `ingestText`. One bad source never aborts the run — its failure is recorded on
 * the source row and the poll continues.
 */

/** Max recent items considered per source per poll (bounds embedding cost). */
const MAX_ITEMS_PER_SOURCE = 10;

/**
 * Feed bodies shorter than this (in characters) are treated as teasers/excerpts
 * and the poller tries to fetch the full article from the item link. The bound
 * sits just under a single chunk's capacity (~400 tokens ≈ 1600 chars), so any
 * item that would otherwise embed into one near-empty chunk is enriched.
 */
const THIN_FEED_BODY_CHARS = 1500;

/** Spacing between arXiv API requests to respect its rate limits. */
const ARXIV_REQUEST_DELAY_MS = 3_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export type PerSourceResult = {
	sourceId: string;
	type: AutomationSource["type"];
	title: string;
	added: number;
	skipped: number;
	status: "ok" | "error" | "partial" | "skipped";
	error?: string;
};

export type PollSummary = {
	added: number;
	skipped: number;
	errors: number;
	perSource: PerSourceResult[];
};

export type PollOptions = {
	db?: Database;
	embedder?: Embedder;
	/** Injectable fetch for RSS feeds (tests). */
	fetchFn?: FetchFn;
	/** Injectable YouTube discovery + transcript ops (tests). */
	youtube?: YoutubeDeps;
	signal?: AbortSignal;
};

/** Strip an HTML body / passthrough plain text into a clean ingest payload. */
function feedItemBytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

async function paperIngestPayload(
	item: {
		title: string;
		abstract: string;
		url: string;
		pdfUrl?: string;
	},
	signal?: AbortSignal,
): Promise<
	| { ok: true; text: string; bytes: number; mime: string; filename: string }
	| { ok: false; reason: string }
> {
	if (!item.pdfUrl) {
		return { ok: false, reason: "No full-text PDF URL was available." };
	}

	const fetched = await httpBinary(item.pdfUrl, {
		accept: "application/pdf, application/octet-stream",
		signal,
	});
	if (!fetched.ok) return { ok: false, reason: fetched.error };
	if (fetched.status < 200 || fetched.status >= 300) {
		return { ok: false, reason: `PDF returned ${fetched.status}.` };
	}

	const extracted = await extractText(
		fetched.body,
		`${item.title || "paper"}.pdf`,
		fetched.mime,
		signal,
	);
	if (!extracted.ok) return { ok: false, reason: extracted.error };
	if (extracted.text.trim().length <= item.abstract.length) {
		return { ok: false, reason: "Full text extraction was not usable." };
	}

	return {
		ok: true,
		text: extracted.text,
		bytes: fetched.body.byteLength,
		mime: fetched.mime,
		filename: item.pdfUrl,
	};
}

async function pollRssSource(
	source: AutomationSource,
	deps: {
		db: Database;
		embedder: Embedder;
		fetchFn: FetchFn;
		signal?: AbortSignal;
	},
): Promise<PerSourceResult> {
	const result: PerSourceResult = {
		sourceId: source.id,
		type: "rss",
		title: source.title ?? source.url,
		added: 0,
		skipped: 0,
		status: "ok",
	};

	const feed = await fetchFeed(source.url, {
		fetchFn: deps.fetchFn,
		signal: deps.signal,
		etag: source.etag,
		lastModified: source.lastModified,
	});
	if (!feed.ok) {
		result.status = "error";
		result.error = feed.error;
		return result;
	}
	// Conditional GET hit — nothing changed upstream, so skip the whole body.
	if (feed.notModified) {
		return result;
	}
	setSourceHttpCache(
		source.id,
		{ etag: feed.etag, lastModified: feed.lastModified },
		deps.db,
	);

	const items = feed.feed.items.slice(0, MAX_ITEMS_PER_SOURCE);
	for (const item of items) {
		const externalId = item.guid || item.link;
		if (!externalId) {
			result.skipped += 1;
			continue;
		}
		if (documentExists(source.id, externalId, deps.db)) {
			result.skipped += 1;
			continue;
		}
		let text = item.content.trim();
		// Enrich teaser/summary-only feeds: fetch the canonical article and extract
		// its main prose. Keep the enriched text only when it yields more than the
		// feed body, so full-content feeds and genuinely short posts are untouched.
		if (item.link && text.length < THIN_FEED_BODY_CHARS) {
			const article = await fetchArticleText(item.link, {
				fetchFn: deps.fetchFn,
				signal: deps.signal,
			});
			if (article.ok && article.text.length > text.length) {
				text = article.text;
			}
		}
		if (text.length === 0) {
			result.skipped += 1;
			continue;
		}

		const ingested = await ingestText(
			{
				text,
				title: item.title || item.link || "Untitled post",
				filename: item.link || externalId,
				mime: "text/html",
				bytes: feedItemBytes(text),
				sourceId: source.id,
				externalId,
				sourceUrl: item.link || undefined,
				publishedAt: item.publishedAt,
			},
			{ db: deps.db, embedder: deps.embedder, signal: deps.signal },
		);
		if (ingested.ok) {
			if (ingested.duplicate) result.skipped += 1;
			else result.added += 1;
		} else {
			result.status = result.added > 0 ? "partial" : "error";
			result.error = ingested.error;
		}
	}

	return result;
}

async function pollPaperSource(
	source: AutomationSource,
	deps: {
		db: Database;
		embedder: Embedder;
		signal?: AbortSignal;
	},
): Promise<PerSourceResult> {
	const result: PerSourceResult = {
		sourceId: source.id,
		type: source.type,
		title: source.title ?? source.url,
		added: 0,
		skipped: 0,
		status: "ok",
	};

	if (!isPaperType(source.type)) {
		result.status = "error";
		result.error = `Unknown paper source type: ${source.type}.`;
		return result;
	}

	const provider = getPaperProvider(source.type);
	const listed = await provider.list(
		source.url,
		source.identifier,
		MAX_ITEMS_PER_SOURCE,
		deps.signal,
	);
	if (!listed.ok) {
		result.status = "error";
		result.error = listed.error;
		return result;
	}

	for (const item of listed.items) {
		if (item.externalId.length === 0 || item.abstract.length === 0) {
			result.skipped += 1;
			continue;
		}
		if (documentExists(source.id, item.externalId, deps.db)) {
			result.skipped += 1;
			continue;
		}

		// Prefer the full-text PDF; when it can't be fetched (paywall, bot
		// challenge, no PDF URL) fall back to ingesting title + abstract so the
		// item is recorded once and never re-fetched on every later poll.
		const payload = await paperIngestPayload(item, deps.signal);
		const abstractText = `${item.title}\n\n${item.abstract}`;
		const ingested = await ingestText(
			payload.ok
				? {
						text: payload.text,
						title: item.title || item.externalId,
						filename: payload.filename,
						mime: payload.mime,
						bytes: payload.bytes,
						sourceId: source.id,
						externalId: item.externalId,
						sourceUrl: item.url || undefined,
						publishedAt: item.publishedAt,
					}
				: {
						text: abstractText,
						title: item.title || item.externalId,
						filename: item.url || item.externalId,
						mime: "text/plain",
						bytes: feedItemBytes(abstractText),
						sourceId: source.id,
						externalId: item.externalId,
						sourceUrl: item.url || undefined,
						publishedAt: item.publishedAt,
					},
			{ db: deps.db, embedder: deps.embedder, signal: deps.signal },
		);
		if (ingested.ok) {
			if (ingested.duplicate) result.skipped += 1;
			else result.added += 1;
		} else {
			result.status = result.added > 0 ? "partial" : "error";
			result.error = ingested.error;
		}
	}

	return result;
}

async function pollYoutubeSource(
	source: AutomationSource,
	deps: {
		db: Database;
		embedder: Embedder;
		youtube: YoutubeDeps;
		signal?: AbortSignal;
	},
): Promise<PerSourceResult> {
	const result: PerSourceResult = {
		sourceId: source.id,
		type: "youtube",
		title: source.title ?? source.url,
		added: 0,
		skipped: 0,
		status: "ok",
	};

	const channelId = source.identifier;
	if (!channelId) {
		result.status = "error";
		result.error = "Source is missing its channel id.";
		return result;
	}

	const listed = await deps.youtube.listVideos(channelId, MAX_ITEMS_PER_SOURCE);
	if (!listed.ok) {
		result.status = "error";
		result.error = listed.error;
		return result;
	}

	for (const video of listed.videos) {
		if (documentExists(source.id, video.videoId, deps.db)) {
			result.skipped += 1;
			continue;
		}

		const transcript = await deps.youtube.fetchTranscript(video.videoId);
		if (!transcript.ok) {
			// Skip-with-reason: brittle transcript path must never fail the source.
			result.skipped += 1;
			result.error = transcript.reason;
			continue;
		}

		const ingested = await ingestText(
			{
				text: transcript.text,
				title: video.title,
				filename: video.url,
				mime: "text/plain",
				bytes: feedItemBytes(transcript.text),
				sourceId: source.id,
				externalId: video.videoId,
				sourceUrl: video.url,
				publishedAt: video.publishedAt,
			},
			{ db: deps.db, embedder: deps.embedder, signal: deps.signal },
		);
		if (ingested.ok) {
			if (ingested.duplicate) result.skipped += 1;
			else result.added += 1;
		} else {
			result.status = result.added > 0 ? "partial" : "error";
			result.error = ingested.error;
		}
	}

	return result;
}

/**
 * Run a single poll across all enabled sources. Returns an aggregate summary and
 * persists per-source status + the run timestamp. Embeddings need the OpenAI key
 * (same as manual uploads); when absent the run records a clear error per source
 * rather than throwing.
 */
export async function runPoll(options: PollOptions = {}): Promise<PollSummary> {
	const db = options.db ?? getDatabase();
	const embedder = options.embedder ?? embedTexts;
	const fetchFn = options.fetchFn ?? fetch;
	const youtube = options.youtube ?? defaultYoutubeDeps;

	const sources = listEnabledSources(db);
	const perSource: PerSourceResult[] = [];

	const hasEmbedKey = Boolean(
		options.embedder ?? resolveProviderKey("openai", db).key,
	);

	for (const source of sources) {
		let result: PerSourceResult;
		if (!hasEmbedKey) {
			result = {
				sourceId: source.id,
				type: source.type,
				title: source.title ?? source.url,
				added: 0,
				skipped: 0,
				status: "error",
				error: "An OpenAI API key is required for embeddings.",
			};
		} else if (source.type === "rss") {
			result = await pollRssSource(source, {
				db,
				embedder,
				fetchFn,
				signal: options.signal,
			});
		} else if (source.type === "youtube") {
			result = await pollYoutubeSource(source, {
				db,
				embedder,
				youtube,
				signal: options.signal,
			});
		} else {
			// arXiv asks callers to space requests; pause before each arXiv poll.
			if (source.type === "arxiv") {
				await delay(ARXIV_REQUEST_DELAY_MS, options.signal);
			}
			result = await pollPaperSource(source, {
				db,
				embedder,
				signal: options.signal,
			});
		}

		updateSourceStatus(
			source.id,
			{
				status: result.status,
				// Only persist an error message when the source didn't fully succeed;
				// a skip reason on an otherwise-ok source isn't a failure to surface.
				error: result.status === "ok" ? null : (result.error ?? null),
				itemCount: result.added,
			},
			db,
		);
		perSource.push(result);
	}

	setLastRunAt(Date.now(), db);

	return {
		added: perSource.reduce((sum, item) => sum + item.added, 0),
		skipped: perSource.reduce((sum, item) => sum + item.skipped, 0),
		errors: perSource.filter((item) => item.status === "error").length,
		perSource,
	};
}
