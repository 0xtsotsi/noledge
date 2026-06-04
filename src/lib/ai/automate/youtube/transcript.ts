import type { Innertube } from "youtubei.js";
import { getYoutubeClient } from "./client";

/**
 * YouTube transcript fetcher built on the unofficial InnerTube client
 * (LuanRT/YouTube.js). Captions for videos you don't own can't come from the
 * official API (`captions.download` needs OAuth ownership), so we read the
 * caption-track list off the player response (`getInfo().captions`) and fetch the
 * `timedtext` track directly as json3.
 *
 * We deliberately do NOT use `info.getTranscript()` — its `get_transcript`
 * endpoint currently returns intermittent 400s (YouTube.js issue #1102). Reading
 * the caption track URL straight from the player response avoids that endpoint.
 *
 * This path is inherently brittle (no captions, age/region gating, cloud-IP
 * blocking, rate limits, format drift), so every failure is reported as a
 * **skip with a reason** rather than thrown. The module is swappable: a paid
 * transcript API could replace {@link fetchTranscript} without touching the poller.
 */

export type TranscriptResult =
	| { ok: true; text: string }
	| { ok: false; skipped: true; reason: string };

type CaptionTrack = {
	base_url: string;
	language_code: string;
	kind?: string;
};

type Json3Response = {
	events?: { segs?: { utf8?: string }[] }[];
};

type VideoInfo = Awaited<ReturnType<Innertube["getInfo"]>>;

/** Pick the best caption track: prefer the requested language, else any. */
function pickTrack(
	tracks: CaptionTrack[],
	preferredLang: string,
): CaptionTrack | undefined {
	const withUrl = tracks.filter((track) => Boolean(track.base_url));
	if (withUrl.length === 0) return undefined;
	const exact = withUrl.find(
		(track) => track.language_code?.toLowerCase() === preferredLang,
	);
	if (exact) return exact;
	const prefix = withUrl.find((track) =>
		track.language_code?.toLowerCase().startsWith(preferredLang),
	);
	return prefix ?? withUrl[0];
}

function normalizeTranscriptLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Flatten a json3 caption document into plain transcript text. */
function json3ToText(doc: Json3Response): string {
	const lines: string[] = [];
	for (const event of doc.events ?? []) {
		if (!event.segs) continue;
		const line = normalizeTranscriptLine(
			event.segs.map((seg) => seg.utf8 ?? "").join(""),
		);
		if (line.length > 0) lines.push(line);
	}
	return lines.join("\n");
}

function languageAliases(language: string): string[] {
	if (language === "en") return ["english", "english (auto-generated)"];
	return [language];
}

async function fetchInnerTubeTranscript(
	info: VideoInfo,
	language: string,
): Promise<TranscriptResult> {
	try {
		let transcriptInfo = await info.getTranscript();
		const languageItems =
			transcriptInfo.transcript?.content?.footer?.language_menu
				?.sub_menu_items ?? [];
		const aliases = languageAliases(language);
		const selectedLanguage = languageItems.find((item) => {
			const title = item.title.toString().toLowerCase();
			return aliases.some(
				(alias) => title === alias || title.startsWith(`${alias} `),
			);
		});

		if (
			selectedLanguage &&
			!selectedLanguage.selected &&
			transcriptInfo.selectLanguage
		) {
			transcriptInfo = await transcriptInfo.selectLanguage(
				selectedLanguage.title.toString(),
			);
		}

		const segments =
			transcriptInfo.transcript?.content?.body?.initial_segments ?? [];
		const text = segments
			.map((segment) =>
				normalizeTranscriptLine(segment.snippet?.toString() ?? ""),
			)
			.filter((line) => line.length > 0)
			.join("\n");

		if (text.trim().length === 0) {
			return { ok: false, skipped: true, reason: "Transcript was empty." };
		}
		return { ok: true, text };
	} catch (error) {
		return {
			ok: false,
			skipped: true,
			reason:
				error instanceof Error
					? `InnerTube transcript fallback failed: ${error.message}`
					: "InnerTube transcript fallback failed.",
		};
	}
}

/**
 * Fetch a transcript for `videoId`. Returns the joined caption text, or a skip
 * with a human-readable reason when captions are unavailable or YouTube blocks
 * the request. Never throws on network/format failures.
 */
export async function fetchTranscript(
	videoId: string,
	options: { client?: Innertube; language?: string } = {},
): Promise<TranscriptResult> {
	const language = (options.language ?? "en").toLowerCase();

	let yt: Innertube;
	try {
		yt = options.client ?? (await getYoutubeClient());
	} catch (error) {
		return {
			ok: false,
			skipped: true,
			reason:
				error instanceof Error
					? `Transcript client unavailable: ${error.message}`
					: "Transcript client unavailable.",
		};
	}

	let info: VideoInfo;
	let tracks: CaptionTrack[];
	try {
		info = await yt.getInfo(videoId);
		tracks = info.captions?.caption_tracks ?? [];
	} catch (error) {
		return {
			ok: false,
			skipped: true,
			reason:
				error instanceof Error
					? `Could not load video: ${error.message}`
					: "Could not load video.",
		};
	}

	const track = pickTrack(tracks, language);
	if (!track) {
		return fetchInnerTubeTranscript(info, language);
	}

	// Append fmt=json3 for structured caption events.
	const url = track.base_url.includes("fmt=")
		? track.base_url
		: `${track.base_url}&fmt=json3`;

	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json,text/plain,*/*",
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
			},
		});
		if (!response.ok) {
			const fallback = await fetchInnerTubeTranscript(info, language);
			if (fallback.ok) return fallback;
			return {
				ok: false,
				skipped: true,
				reason: `Caption track returned ${response.status}; ${fallback.reason}`,
			};
		}
		const body = await response.text();
		if (body.trim().length === 0) {
			const fallback = await fetchInnerTubeTranscript(info, language);
			if (fallback.ok) return fallback;
			// Empty body is the classic PO-token / IP-block symptom.
			return {
				ok: false,
				skipped: true,
				reason: `Caption track returned empty (likely blocked or gated); ${fallback.reason}`,
			};
		}
		const text = json3ToText(JSON.parse(body) as Json3Response);
		if (text.trim().length === 0) {
			const fallback = await fetchInnerTubeTranscript(info, language);
			if (fallback.ok) return fallback;
			return { ok: false, skipped: true, reason: fallback.reason };
		}
		return { ok: true, text };
	} catch (error) {
		const fallback = await fetchInnerTubeTranscript(info, language);
		if (fallback.ok) return fallback;
		return {
			ok: false,
			skipped: true,
			reason:
				error instanceof Error
					? `Caption fetch failed: ${error.message}; ${fallback.reason}`
					: `Caption fetch failed; ${fallback.reason}`,
		};
	}
}
