import { normalizeText } from "@/lib/ai/rag/normalize";
import { httpText } from "./http";
import type {
	PaperItem,
	PaperListResult,
	PaperPreviewResult,
	PaperProvider,
} from "./types";

/**
 * bioRxiv / medRxiv provider. These APIs have no keyword search, so this browses
 * the latest preprints in a recent date window and (optionally) filters by
 * `category` client-side. `query` carries the category (blank → all); the
 * `identifier` is unused. Dedup on DOI means re-polling the same window is cheap.
 */

export type BiorxivServer = "biorxiv" | "medrxiv";

/** How far back to look for "latest" preprints, in days. */
const WINDOW_DAYS = 30;

type BiorxivItem = {
	doi?: unknown;
	title?: unknown;
	abstract?: unknown;
	date?: unknown;
	version?: unknown;
	category?: unknown;
};

type BiorxivResponse = {
	collection?: BiorxivItem[];
};

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function formatDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** Normalize the stored query into a category filter ("" / "latest" → no filter). */
function toCategory(query: string): string {
	const trimmed = query.trim();
	return trimmed.toLowerCase() === "latest" ? "" : trimmed;
}

function mapItem(item: BiorxivItem, server: BiorxivServer): PaperItem {
	const doi = asString(item.doi);
	const version = asString(item.version) || "1";
	const date = asString(item.date);
	const ms = date.length > 0 ? Date.parse(date) : Number.NaN;
	const host = server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
	const url = doi.length > 0 ? `https://${host}/content/${doi}v${version}` : "";
	return {
		externalId: doi,
		title: normalizeText(asString(item.title)),
		abstract: normalizeText(asString(item.abstract)),
		url,
		...(url.length > 0 ? { pdfUrl: `${url}.full.pdf` } : {}),
		publishedAt: Number.isNaN(ms) ? null : ms,
	};
}

/**
 * Parse a bioRxiv details response into paper items, optionally filtered by
 * category (case-insensitive), newest first, capped to `limit`.
 */
export function parseBiorxiv(
	body: string,
	server: BiorxivServer,
	category: string,
	limit: number,
): PaperItem[] {
	let data: BiorxivResponse;
	try {
		data = JSON.parse(body) as BiorxivResponse;
	} catch {
		return [];
	}
	if (!Array.isArray(data.collection)) return [];
	const wanted = category.trim().toLowerCase();
	const seen = new Set<string>();
	return data.collection
		.map((item) => ({ raw: item, mapped: mapItem(item, server) }))
		.filter(({ raw, mapped }) => {
			if (mapped.externalId.length === 0 || mapped.abstract.length === 0) {
				return false;
			}
			if (
				wanted.length > 0 &&
				asString(raw.category).toLowerCase() !== wanted
			) {
				return false;
			}
			// Multiple versions of the same DOI can appear; keep the first (newest).
			if (seen.has(mapped.externalId)) return false;
			seen.add(mapped.externalId);
			return true;
		})
		.map(({ mapped }) => mapped)
		.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
		.slice(0, limit);
}

function buildUrl(server: BiorxivServer): string {
	const now = Date.now();
	const from = formatDate(now - WINDOW_DAYS * 24 * 60 * 60 * 1000);
	const to = formatDate(now);
	return `https://api.biorxiv.org/details/${server}/${from}/${to}/0`;
}

/** Build a provider bound to a specific preprint server. */
export function fetchBiorxiv(server: BiorxivServer): PaperProvider {
	const label = server === "medrxiv" ? "medRxiv" : "bioRxiv";

	async function fetchItems(
		category: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<{ ok: true; items: PaperItem[] } | { ok: false; error: string }> {
		const result = await httpText(buildUrl(server), {
			accept: "application/json",
			signal,
		});
		if (!result.ok) return { ok: false, error: result.error };
		if (result.status !== 200) {
			return { ok: false, error: `${label} returned ${result.status}.` };
		}
		return {
			ok: true,
			items: parseBiorxiv(result.body, server, category, limit),
		};
	}

	return {
		async preview(
			query: string,
			_identifier: string | null,
			signal?: AbortSignal,
		): Promise<PaperPreviewResult> {
			const category = toCategory(query);
			const result = await fetchItems(category, 5, signal);
			if (!result.ok) return { ok: false, error: result.error };
			if (result.items.length === 0) {
				return {
					ok: false,
					error:
						category.length > 0
							? `No recent ${label} preprints in "${category}".`
							: `No recent ${label} preprints found.`,
				};
			}
			return {
				ok: true,
				preview: {
					title:
						category.length > 0
							? `${label} · ${category}`
							: `${label} · latest`,
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
			_identifier: string | null,
			limit: number,
			signal?: AbortSignal,
		): Promise<PaperListResult> {
			return fetchItems(toCategory(query), limit, signal);
		},
	};
}
