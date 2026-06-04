import { z } from "zod";
import { previewFeed } from "@/lib/ai/automate/rss/preview";
import {
	type AutomationSource,
	addSource,
	deleteSource,
	findDuplicateSource,
	listSources,
} from "@/lib/ai/automate/store";
import { resolveChannel } from "@/lib/ai/automate/youtube/channel";

function serialize(source: AutomationSource): Record<string, unknown> {
	return {
		id: source.id,
		type: source.type,
		url: source.url,
		identifier: source.identifier,
		title: source.title,
		enabled: source.enabled,
		createdAt: source.createdAt,
		lastPolledAt: source.lastPolledAt,
		lastStatus: source.lastStatus,
		lastError: source.lastError,
		lastItemCount: source.lastItemCount,
	};
}

/** List sources grouped by type. */
export async function GET(): Promise<Response> {
	const sources = listSources();
	return Response.json({
		rss: sources.filter((s) => s.type === "rss").map(serialize),
		youtube: sources.filter((s) => s.type === "youtube").map(serialize),
	});
}

const postSchema = z.object({
	type: z.enum(["rss", "youtube"]),
	url: z.string().min(1, "URL is required"),
});

/** Resolve + validate, then add a source. */
export async function POST(request: Request): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = postSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid request" },
			{ status: 400 },
		);
	}

	const { type, url } = parsed.data;
	const trimmedUrl = url.trim();

	if (type === "rss") {
		const preview = await previewFeed(trimmedUrl, request.signal);
		if (!preview.ok) {
			return Response.json({ error: preview.error }, { status: 422 });
		}
		const duplicate = findDuplicateSource({ type: "rss", url: trimmedUrl });
		if (duplicate) {
			return Response.json(
				{ error: "This feed has already been added." },
				{ status: 409 },
			);
		}
		const source = addSource({
			type: "rss",
			url: trimmedUrl,
			title: preview.preview.title,
		});
		return Response.json({ source: serialize(source) });
	}

	const resolved = await resolveChannel(trimmedUrl);
	if (!resolved.ok) {
		return Response.json({ error: resolved.error }, { status: 422 });
	}
	const duplicate = findDuplicateSource({
		type: "youtube",
		url: trimmedUrl,
		identifier: resolved.channel.channelId,
	});
	if (duplicate) {
		return Response.json(
			{ error: "This channel has already been added." },
			{ status: 409 },
		);
	}
	const source = addSource({
		type: "youtube",
		url: trimmedUrl,
		identifier: resolved.channel.channelId,
		title: resolved.channel.title,
	});
	return Response.json({ source: serialize(source) });
}

/** Remove a source by id. */
export async function DELETE(request: Request): Promise<Response> {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) {
		return Response.json(
			{ error: "Missing `id` query param" },
			{ status: 400 },
		);
	}
	const removed = deleteSource(id);
	if (!removed) {
		return Response.json({ error: "Source not found" }, { status: 404 });
	}
	return Response.json({ deleted: id });
}
