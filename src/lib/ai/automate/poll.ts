import type { Database } from "better-sqlite3";
import { getDatabase } from "@/lib/ai/db/client";
import { embedTexts } from "@/lib/ai/embeddings/embed";
import { resolveProviderKey } from "@/lib/ai/models/provider-config";
import type { Embedder } from "@/lib/ai/rag/ingest";
import { ingestText } from "@/lib/ai/rag/ingest";
import { fetchFeed } from "./rss/parse";
import {
	type AutomationSource,
	documentExists,
	listEnabledSources,
	setLastRunAt,
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

export type PerSourceResult = {
	sourceId: string;
	type: AutomationSource["type"];
	title: string;
	added: number;
	skipped: number;
	status: "ok" | "error" | "partial";
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
	});
	if (!feed.ok) {
		result.status = "error";
		result.error = feed.error;
		return result;
	}

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
		const text = item.content.trim();
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
		} else {
			result = await pollYoutubeSource(source, {
				db,
				embedder,
				youtube,
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
