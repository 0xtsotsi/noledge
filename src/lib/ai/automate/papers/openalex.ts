import { normalizeText } from "@/lib/ai/rag/normalize";
import { httpText } from "./http";
import type {
	PaperItem,
	PaperListResult,
	PaperPreviewResult,
	PaperProvider,
} from "./types";

/**
 * OpenAlex provider. Searches works by free-text keyword (`search=`) or by title
 * (`filter=title.search:`). Abstracts arrive as an inverted index (word →
 * positions) and are reconstructed into prose; items without a usable abstract
 * are dropped. `identifier` carries the mode (`"keyword" | "title"`).
 */

const OPENALEX_ENDPOINT = "https://api.openalex.org/works";
const MAILTO = "noledge-automation@users.noreply.github.com";

/**
 * Reconstruct prose from an OpenAlex `abstract_inverted_index` (word → list of
 * positions). Returns "" when the map is absent/empty so callers can skip the
 * item.
 */
export function reconstructAbstract(
	index: Record<string, number[]> | null | undefined,
): string {
	if (!index) return "";
	const slots: string[] = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const position of positions) {
			if (Number.isInteger(position) && position >= 0) {
				slots[position] = word;
			}
		}
	}
	if (slots.length === 0) return "";
	return slots
		.map((word) => word ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

type OpenAlexLocation = {
	landing_page_url?: unknown;
	pdf_url?: unknown;
};

type OpenAlexWork = {
	id?: unknown;
	title?: unknown;
	display_name?: unknown;
	publication_date?: unknown;
	abstract_inverted_index?: unknown;
	primary_location?: OpenAlexLocation | null;
	best_oa_location?: OpenAlexLocation | null;
};

type OpenAlexResponse = {
	results?: OpenAlexWork[];
};

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asInvertedIndex(value: unknown): Record<string, number[]> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, number[]>;
}

/** OpenAlex id (`https://openalex.org/W123`) → bare work id (`W123`). */
function workId(idUrl: string): string {
	const match = idUrl.match(/\/(W\d+)$/);
	return match?.[1] ?? idUrl;
}

function mapWork(work: OpenAlexWork): PaperItem {
	const idUrl = asString(work.id);
	const landing =
		asString(work.best_oa_location?.landing_page_url) ||
		asString(work.primary_location?.landing_page_url);
	const pdfUrl =
		asString(work.best_oa_location?.pdf_url) ||
		asString(work.primary_location?.pdf_url);
	const date = asString(work.publication_date);
	const ms = date.length > 0 ? Date.parse(date) : Number.NaN;
	return {
		externalId: workId(idUrl),
		title: normalizeText(asString(work.title) || asString(work.display_name)),
		abstract: normalizeText(
			reconstructAbstract(asInvertedIndex(work.abstract_inverted_index)),
		),
		url: landing || idUrl,
		...(pdfUrl.length > 0 ? { pdfUrl } : {}),
		publishedAt: Number.isNaN(ms) ? null : ms,
	};
}

/** Parse an OpenAlex `/works` JSON response into paper items. */
export function parseOpenalex(body: string): PaperItem[] {
	let data: OpenAlexResponse;
	try {
		data = JSON.parse(body) as OpenAlexResponse;
	} catch {
		return [];
	}
	if (!Array.isArray(data.results)) return [];
	return data.results.map(mapWork);
}

function buildUrl(
	query: string,
	identifier: string | null,
	limit: number,
): string {
	const value = query.trim();
	const params = new URLSearchParams({
		"per-page": String(limit),
		mailto: MAILTO,
	});
	if (identifier === "title") {
		params.set("filter", `title.search:${value}`);
	} else {
		params.set("search", value);
	}
	return `${OPENALEX_ENDPOINT}?${params.toString()}`;
}

async function fetchWorks(
	query: string,
	identifier: string | null,
	limit: number,
	signal?: AbortSignal,
): Promise<{ ok: true; items: PaperItem[] } | { ok: false; error: string }> {
	const result = await httpText(buildUrl(query, identifier, limit), {
		accept: "application/json",
		signal,
	});
	if (!result.ok) return { ok: false, error: result.error };
	if (result.status !== 200) {
		return { ok: false, error: `OpenAlex returned ${result.status}.` };
	}
	// Drop items with no reconstructable abstract — they carry no ingestable text.
	const items = parseOpenalex(result.body).filter(
		(item) => item.abstract.length > 0,
	);
	return { ok: true, items };
}

export const fetchOpenalex: PaperProvider = {
	async preview(
		query: string,
		identifier: string | null,
		signal?: AbortSignal,
	): Promise<PaperPreviewResult> {
		if (query.trim().length === 0) {
			return { ok: false, error: "A search term is required." };
		}
		const result = await fetchWorks(query, identifier, 5, signal);
		if (!result.ok) return { ok: false, error: result.error };
		if (result.items.length === 0) {
			return { ok: false, error: "No matching OpenAlex works found." };
		}
		return {
			ok: true,
			preview: {
				title: `OpenAlex · "${query.trim()}"`,
				itemCount: result.items.length,
				latestTitles: result.items
					.slice(0, 3)
					.map((item) => item.title)
					.filter((title) => title.length > 0),
			},
		};
	},

	async list(
		query: string,
		identifier: string | null,
		limit: number,
		signal?: AbortSignal,
	): Promise<PaperListResult> {
		return fetchWorks(query, identifier, limit, signal);
	},
};
