/**
 * Cheap per-claim citation via n-gram overlap. No LLM call.
 *
 * Splits an answer into sentences, scores each against each source's content
 * via Jaccard similarity over stop-word-filtered 3-grams, and returns the
 * top-1 citation per sentence above a threshold. The 0.25 default is tuned
 * for short factoid sentences; longer sentences can use a slightly lower
 * threshold because they have more overlap with their grounding chunk.
 */

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"in",
	"on",
	"for",
	"to",
	"and",
	"or",
	"but",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"has",
	"have",
	"had",
	"do",
	"does",
	"did",
	"this",
	"that",
	"these",
	"those",
	"it",
	"its",
	"as",
	"at",
	"by",
	"from",
	"with",
	"they",
	"them",
	"their",
	"there",
	"here",
	"when",
	"where",
	"what",
	"how",
	"why",
	"who",
	"i",
	"you",
	"we",
	"he",
	"she",
]);

const NGRAM_N = 3;
const DEFAULT_THRESHOLD = 0.25;
const SNIPPET_MAX_CHARS = 160;

type SourceLike = {
	id: string;
	title: string;
	content: string;
	score?: number;
};

export type ClaimCitation = {
	sentence: string;
	chunkId: string;
	documentTitle: string;
	score: number;
	snippet: string;
};

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

function ngrams(text: string, n: number = NGRAM_N): Set<string> {
	const tokens = tokenize(text);
	const out = new Set<string>();
	if (tokens.length < n) return out;
	for (let i = 0; i <= tokens.length - n; i++) {
		out.add(tokens.slice(i, i + n).join(" "));
	}
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return inter / (a.size + b.size - inter);
}

export function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function computeClaimCitations(
	answer: string,
	sources: SourceLike[],
	options: { threshold?: number; snippetMaxChars?: number } = {},
): ClaimCitation[] {
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const snippetMax = options.snippetMaxChars ?? SNIPPET_MAX_CHARS;
	const sentences = splitSentences(answer);
	if (sentences.length === 0 || sources.length === 0) return [];

	const sourceGrams = sources.map((s) => ({
		source: s,
		grams: ngrams(s.content),
	}));
	const out: ClaimCitation[] = [];
	for (const sentence of sentences) {
		const grams = ngrams(sentence);
		if (grams.size === 0) continue;
		let best: {
			source: SourceLike;
			grams: Set<string>;
			overlap: number;
		} | null = null;
		for (const sg of sourceGrams) {
			const o = jaccard(grams, sg.grams);
			if (best === null || o > best.overlap) {
				best = { source: sg.source, grams: sg.grams, overlap: o };
			}
		}
		if (best && best.overlap >= threshold) {
			out.push({
				sentence,
				chunkId: best.source.id,
				documentTitle: best.source.title,
				score: Number(best.overlap.toFixed(4)),
				snippet: best.source.content.slice(0, snippetMax),
			});
		}
	}
	return out;
}
