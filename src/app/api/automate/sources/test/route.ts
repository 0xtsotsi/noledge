import { z } from "zod";
import { getPaperProvider, isPaperType } from "@/lib/ai/automate/papers";
import { previewFeed } from "@/lib/ai/automate/rss/preview";
import { resolveChannel } from "@/lib/ai/automate/youtube/channel";
import { fetchTranscript } from "@/lib/ai/automate/youtube/transcript";
import { listRecentVideos } from "@/lib/ai/automate/youtube/videos";

const testSchema = z.object({
	type: z.enum([
		"rss",
		"youtube",
		"arxiv",
		"openalex",
		"pubmed",
		"biorxiv",
		"medrxiv",
	]),
	url: z.string().min(1, "URL is required"),
	identifier: z.string().nullish(),
});

/**
 * Validate a source URL before saving and return a small preview. RSS → feed
 * title + latest titles + count. YouTube → resolved channel title, recent video
 * count, and whether a transcript probe on the latest video succeeded.
 */
export async function POST(request: Request): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = testSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid request" },
			{ status: 400 },
		);
	}

	const { type, url, identifier } = parsed.data;
	const trimmedUrl = url.trim();

	if (type === "rss") {
		const preview = await previewFeed(trimmedUrl, request.signal);
		if (!preview.ok) {
			return Response.json({ error: preview.error }, { status: 422 });
		}
		return Response.json({ type: "rss", preview: preview.preview });
	}

	if (isPaperType(type)) {
		const provider = getPaperProvider(type);
		const preview = await provider.preview(
			trimmedUrl,
			identifier ?? null,
			request.signal,
		);
		if (!preview.ok) {
			return Response.json({ error: preview.error }, { status: 422 });
		}
		return Response.json({ type, preview: preview.preview });
	}

	const resolved = await resolveChannel(trimmedUrl);
	if (!resolved.ok) {
		return Response.json({ error: resolved.error }, { status: 422 });
	}

	const listed = await listRecentVideos(resolved.channel.channelId, 5);
	const videoCount = listed.ok ? listed.videos.length : 0;
	const latest = listed.ok ? listed.videos[0] : undefined;

	let transcriptOk = false;
	let transcriptReason: string | null = null;
	if (latest) {
		const transcript = await fetchTranscript(latest.videoId);
		transcriptOk = transcript.ok;
		transcriptReason = transcript.ok ? null : transcript.reason;
	}

	return Response.json({
		type: "youtube",
		preview: {
			title: resolved.channel.title,
			videoCount,
			latestTitle: latest?.title ?? null,
			transcriptOk,
			transcriptReason,
		},
	});
}
