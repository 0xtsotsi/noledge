/**
 * Shared types and utilities for YouTube transcript fetching.
 */

export type TranscriptResult =
	| { ok: true; text: string }
	| { ok: false; skipped: true; reason: string };

export type Json3Response = {
	events?: { segs?: { utf8?: string }[] }[];
};

function normalizeTranscriptLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Flatten a json3 caption document into plain transcript text. */
export function json3ToText(doc: Json3Response): string {
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
