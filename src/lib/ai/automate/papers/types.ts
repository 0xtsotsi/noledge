import type { RssPreview } from "@/lib/ai/automate/rss/preview";

/**
 * Shared contract for the credential-free academic-paper providers (arXiv,
 * OpenAlex, PubMed, bioRxiv/medRxiv). Each provider validates a query + optional
 * mode and exposes a small preview plus a recent-items list the poller ingests.
 */

/** Provider keys, also used verbatim as the stored `automation_sources.type`. */
export const PAPER_TYPES = [
	"arxiv",
	"openalex",
	"pubmed",
	"biorxiv",
	"medrxiv",
] as const;

export type PaperType = (typeof PAPER_TYPES)[number];

export type PaperItem = {
	/** Stable per-source identity: arXiv id / OpenAlex id / PMID / DOI. */
	externalId: string;
	title: string;
	/** Plain-text abstract; an empty string means the item is skipped. */
	abstract: string;
	/** Landing page for display. */
	url: string;
	/** Publication time in epoch ms, when known. */
	publishedAt: number | null;
};

export type PaperPreviewResult =
	| { ok: true; preview: RssPreview }
	| { ok: false; error: string };

export type PaperListResult =
	| { ok: true; items: PaperItem[] }
	| { ok: false; error: string };

export type PaperProvider = {
	/** Validate config + return a small preview (title / itemCount / latestTitles). */
	preview(
		query: string,
		identifier: string | null,
		signal?: AbortSignal,
	): Promise<PaperPreviewResult>;
	/** List recent items for the poller. */
	list(
		query: string,
		identifier: string | null,
		limit: number,
		signal?: AbortSignal,
	): Promise<PaperListResult>;
};
