import { fetchArxiv } from "./arxiv";
import { fetchBiorxiv } from "./biorxiv";
import { fetchOpenalex } from "./openalex";
import { fetchPubmed } from "./pubmed";
import { PAPER_TYPES, type PaperProvider, type PaperType } from "./types";

/** Provider registry + type guard for the academic-paper sources. */

export { type HttpTextResult, httpText } from "./http";

const PAPER_TYPE_SET = new Set<string>(PAPER_TYPES);

/** Type guard: is this stored `type` one of the paper providers? */
export function isPaperType(type: string): type is PaperType {
	return PAPER_TYPE_SET.has(type);
}

const providers: Record<PaperType, PaperProvider> = {
	arxiv: fetchArxiv,
	openalex: fetchOpenalex,
	pubmed: fetchPubmed,
	biorxiv: fetchBiorxiv("biorxiv"),
	medrxiv: fetchBiorxiv("medrxiv"),
};

/** Resolve a provider implementation for a paper `type`. */
export function getPaperProvider(type: PaperType): PaperProvider {
	return providers[type];
}
