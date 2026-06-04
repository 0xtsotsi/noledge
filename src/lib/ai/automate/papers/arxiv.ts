import { XMLParser } from "fast-xml-parser";
import { normalizeText } from "@/lib/ai/rag/normalize";
import { httpText } from "./http";
import type {
	PaperItem,
	PaperListResult,
	PaperPreviewResult,
	PaperProvider,
} from "./types";

/**
 * arXiv provider. Queries the Atom API by category (`cat:cs.AI`) or free-text
 * keyword (`all:<terms>`), most-recent first. The `identifier` carries the mode
 * (`"category" | "keyword"`); `query` is the raw value the user entered.
 */

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	trimValues: true,
	parseTagValue: false,
	parseAttributeValue: false,
	processEntities: true,
});

type XmlNode = unknown;
type XmlObject = Record<string, unknown>;

function isObject(value: XmlNode): value is XmlObject {
	return typeof value === "object" && value !== null;
}

function toArray<T = XmlNode>(value: XmlNode): T[] {
	if (value === undefined || value === null) return [];
	return (Array.isArray(value) ? value : [value]) as T[];
}

function textValue(node: XmlNode): string {
	if (typeof node === "string") return node;
	if (isObject(node)) {
		const text = node["#text"];
		if (text !== undefined && text !== null) return String(text);
	}
	return "";
}

/** Preferred alternate (`rel=alternate`) link href, else the first href found. */
function alternateHref(link: XmlNode): string {
	let fallback = "";
	for (const candidate of toArray(link)) {
		if (!isObject(candidate)) continue;
		const href = candidate["@_href"];
		if (typeof href !== "string" || href.length === 0) continue;
		const rel = candidate["@_rel"];
		if (rel === undefined || rel === "alternate") return href;
		if (!fallback) fallback = href;
	}
	return fallback;
}

function parseDate(value: string): number | null {
	if (value.length === 0) return null;
	const ms = Date.parse(value.trim());
	return Number.isNaN(ms) ? null : ms;
}

/** Reduce an arXiv abstract URL (`http://arxiv.org/abs/2606.05158v1`) to its id. */
function arxivIdFromUrl(idUrl: string): string {
	const match = idUrl.match(/abs\/(.+)$/);
	return match?.[1] ?? idUrl;
}

function parseEntry(node: XmlObject): PaperItem {
	const idUrl = textValue(node.id);
	const link = alternateHref(node.link) || idUrl;
	return {
		externalId: arxivIdFromUrl(idUrl),
		title: normalizeText(textValue(node.title)),
		abstract: normalizeText(textValue(node.summary)),
		url: link,
		publishedAt: parseDate(
			textValue(node.published) || textValue(node.updated),
		),
	};
}

/** Parse an arXiv Atom response into paper items. */
export function parseArxiv(xml: string): PaperItem[] {
	let root: XmlObject;
	try {
		const parsed = parser.parse(xml) as XmlNode;
		if (!isObject(parsed)) return [];
		root = parsed;
	} catch {
		return [];
	}
	const feed = root.feed;
	if (!isObject(feed)) return [];
	return toArray<XmlObject>(feed.entry).filter(isObject).map(parseEntry);
}

/** Build the `search_query` value for a mode + value. */
function buildSearchQuery(query: string, identifier: string | null): string {
	const value = query.trim();
	return identifier === "category" ? `cat:${value}` : `all:${value}`;
}

async function fetchEntries(
	query: string,
	identifier: string | null,
	limit: number,
	signal?: AbortSignal,
): Promise<{ ok: true; items: PaperItem[] } | { ok: false; error: string }> {
	const search = buildSearchQuery(query, identifier);
	const url = `${ARXIV_ENDPOINT}?search_query=${encodeURIComponent(search)}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${limit}`;
	const result = await httpText(url, {
		accept: "application/atom+xml, application/xml, text/xml",
		signal,
	});
	if (!result.ok) return { ok: false, error: result.error };
	if (result.status === 429) {
		return { ok: false, error: "arXiv rate limit hit; try again shortly." };
	}
	if (result.status !== 200) {
		return { ok: false, error: `arXiv returned ${result.status}.` };
	}
	return { ok: true, items: parseArxiv(result.body) };
}

export const fetchArxiv: PaperProvider = {
	async preview(
		query: string,
		identifier: string | null,
		signal?: AbortSignal,
	): Promise<PaperPreviewResult> {
		if (query.trim().length === 0) {
			return { ok: false, error: "A category or keyword is required." };
		}
		const result = await fetchEntries(query, identifier, 5, signal);
		if (!result.ok) return { ok: false, error: result.error };
		if (result.items.length === 0) {
			return { ok: false, error: "No matching arXiv papers found." };
		}
		const label =
			identifier === "category"
				? `arXiv · ${query.trim()}`
				: `arXiv · "${query.trim()}"`;
		return {
			ok: true,
			preview: {
				title: label,
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
		return fetchEntries(query, identifier, limit, signal);
	},
};
