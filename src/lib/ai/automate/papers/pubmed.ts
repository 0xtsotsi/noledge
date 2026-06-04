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
 * PubMed provider via NCBI E-utilities. Two-step: `esearch` returns the most
 * recent PMIDs for a keyword `term`, then `efetch` returns their titles +
 * abstracts as XML. Unauthenticated use is limited to ~3 req/s, comfortably
 * within our 10-item cap. `identifier` is unused (keyword mode only).
 */

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

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

/** Flatten a node to plain text: strings, `#text`, and nested children joined. */
function deepText(node: XmlNode): string {
	if (typeof node === "string") return node;
	if (typeof node === "number" || typeof node === "boolean")
		return String(node);
	if (Array.isArray(node)) return node.map(deepText).join(" ");
	if (isObject(node)) {
		return Object.entries(node)
			.filter(([key]) => !key.startsWith("@_"))
			.map(([, value]) => deepText(value))
			.join(" ");
	}
	return "";
}

type EsearchResponse = {
	esearchresult?: { idlist?: unknown };
};

/** Parse the JSON `esearch` response into an ordered PMID list. */
export function parsePmids(body: string): string[] {
	let data: EsearchResponse;
	try {
		data = JSON.parse(body) as EsearchResponse;
	} catch {
		return [];
	}
	const list = data.esearchresult?.idlist;
	if (!Array.isArray(list)) return [];
	return list.filter((id): id is string => typeof id === "string");
}

function abstractText(article: XmlObject): string {
	const abstract = article.Abstract;
	if (!isObject(abstract)) return "";
	const parts = toArray(abstract.AbstractText)
		.map((part) => {
			const label =
				isObject(part) && typeof part["@_Label"] === "string"
					? `${part["@_Label"]}: `
					: "";
			return `${label}${deepText(part)}`.trim();
		})
		.filter((part) => part.length > 0);
	return parts.join("\n\n");
}

function pubDateMs(article: XmlObject): number | null {
	const journal = article.Journal;
	const issue = isObject(journal) ? journal.JournalIssue : undefined;
	const pubDate = isObject(issue) ? issue.PubDate : undefined;
	if (!isObject(pubDate)) return null;
	const year = deepText(pubDate.Year);
	if (year.length === 0) return null;
	const month = deepText(pubDate.Month) || "Jan";
	const day = deepText(pubDate.Day) || "1";
	const ms = Date.parse(`${day} ${month} ${year}`);
	return Number.isNaN(ms) ? null : ms;
}

function pmcPdfUrl(node: XmlObject): string | undefined {
	const data = node.PubmedData;
	if (!isObject(data)) return undefined;
	const ids = isObject(data.ArticleIdList)
		? data.ArticleIdList.ArticleId
		: undefined;
	for (const id of toArray(ids)) {
		if (!isObject(id) || id["@_IdType"] !== "pmc") continue;
		const pmcid = deepText(id).trim();
		if (pmcid.length > 0) {
			return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`;
		}
	}
	return undefined;
}

function mapArticle(node: XmlObject): PaperItem | null {
	const citation = node.MedlineCitation;
	if (!isObject(citation)) return null;
	const pmid = deepText(citation.PMID).trim();
	if (pmid.length === 0) return null;
	const article = citation.Article;
	if (!isObject(article)) return null;
	const pdfUrl = pmcPdfUrl(node);
	return {
		externalId: pmid,
		title: normalizeText(deepText(article.ArticleTitle)),
		abstract: normalizeText(abstractText(article)),
		url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
		...(pdfUrl ? { pdfUrl } : {}),
		publishedAt: pubDateMs(article),
	};
}

/** Parse an `efetch` PubMed XML response into paper items. */
export function parsePubmedArticles(xml: string): PaperItem[] {
	let root: XmlObject;
	try {
		const parsed = parser.parse(xml) as XmlNode;
		if (!isObject(parsed)) return [];
		root = parsed;
	} catch {
		return [];
	}
	const set = root.PubmedArticleSet;
	if (!isObject(set)) return [];
	return toArray<XmlObject>(set.PubmedArticle)
		.filter(isObject)
		.map(mapArticle)
		.filter((item): item is PaperItem => item !== null);
}

async function fetchArticles(
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ ok: true; items: PaperItem[] } | { ok: false; error: string }> {
	const term = query.trim();
	const searchParams = new URLSearchParams({
		db: "pubmed",
		term,
		retmax: String(limit),
		sort: "pub+date",
		retmode: "json",
	});
	const search = await httpText(
		`${EUTILS}/esearch.fcgi?${searchParams.toString()}`,
		{ accept: "application/json", signal },
	);
	if (!search.ok) return { ok: false, error: search.error };
	if (search.status !== 200) {
		return { ok: false, error: `PubMed search returned ${search.status}.` };
	}
	const pmids = parsePmids(search.body);
	if (pmids.length === 0) return { ok: true, items: [] };

	const fetchParams = new URLSearchParams({
		db: "pubmed",
		id: pmids.join(","),
		rettype: "abstract",
		retmode: "xml",
	});
	const fetched = await httpText(
		`${EUTILS}/efetch.fcgi?${fetchParams.toString()}`,
		{ accept: "application/xml, text/xml", signal },
	);
	if (!fetched.ok) return { ok: false, error: fetched.error };
	if (fetched.status !== 200) {
		return { ok: false, error: `PubMed fetch returned ${fetched.status}.` };
	}
	const items = parsePubmedArticles(fetched.body).filter(
		(item) => item.abstract.length > 0,
	);
	return { ok: true, items };
}

export const fetchPubmed: PaperProvider = {
	async preview(
		query: string,
		_identifier: string | null,
		signal?: AbortSignal,
	): Promise<PaperPreviewResult> {
		if (query.trim().length === 0) {
			return { ok: false, error: "A search term is required." };
		}
		const result = await fetchArticles(query, 5, signal);
		if (!result.ok) return { ok: false, error: result.error };
		if (result.items.length === 0) {
			return { ok: false, error: "No matching PubMed articles found." };
		}
		return {
			ok: true,
			preview: {
				title: `PubMed · "${query.trim()}"`,
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
		return fetchArticles(query, limit, signal);
	},
};
