export type ChunkUnit = "char" | "token";

export type ChunkOptions = {
	/** Target chunk size, measured in `unit`. */
	size?: number;
	/** Overlap between consecutive chunks, measured in `unit`. */
	overlap?: number;
	/**
	 * Size unit. `"char"` (default) measures raw characters for back-compat;
	 * `"token"` approximates tokens as `ceil(length / 4)` — the standard cheap
	 * heuristic — so chunk sizes track an embedding model's token budget.
	 */
	unit?: ChunkUnit;
};

/** A chunk plus its char offsets `[start, end)` into the normalized text. */
export type ChunkSpan = {
	content: string;
	start: number;
	end: number;
};

const DEFAULT_SIZE = 1000;
const DEFAULT_OVERLAP = 200;

/** Approximate token count for a string (≈4 chars per token). */
function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** A size function mapping a string to its measured length in the active unit. */
type Measure = (text: string) => number;

function measureFor(unit: ChunkUnit): Measure {
	return unit === "token" ? approxTokens : (text) => text.length;
}

/**
 * Boundary separators tried in order of preference: keep paragraphs whole, then
 * sentences/lines, then words, and only split mid-word (`""`) as a last resort.
 * This is the recursive-character strategy used by LangChain et al.
 */
const SEPARATORS = ["\n\n", "\n", " ", ""] as const;

/** Split `text` on `separator`; `""` means split into individual characters. */
function splitOn(text: string, separator: string): string[] {
	if (separator === "") return Array.from(text);
	return text.split(separator).filter((part) => part.length > 0);
}

/** Join pieces back with their separator, returning null for empty results. */
function joinPieces(pieces: string[], separator: string): string | null {
	const text = pieces.join(separator).trim();
	return text.length === 0 ? null : text;
}

/**
 * Greedily pack already-small pieces into chunks near `size`, carrying `overlap`
 * of measured length from the tail of each emitted chunk into the next. Mirrors
 * LangChain's `_merge_splits` so windows advance deterministically. Sizes are
 * compared via `measure`, with the separator's own length included.
 */
function mergePieces(
	pieces: string[],
	separator: string,
	size: number,
	overlap: number,
	measure: Measure,
): string[] {
	const sepLen = measure(separator);
	const chunks: string[] = [];
	const current: string[] = [];
	let total = 0;

	for (const piece of pieces) {
		const len = measure(piece);
		const withSep = total + len + (current.length > 0 ? sepLen : 0);
		if (withSep > size && current.length > 0) {
			const chunk = joinPieces(current, separator);
			if (chunk !== null) chunks.push(chunk);
			// Shrink the window from the front until the carried overlap fits.
			while (
				total > overlap ||
				(total + len + (current.length > 0 ? sepLen : 0) > size && total > 0)
			) {
				const head = current[0];
				total -=
					(head === undefined ? 0 : measure(head)) +
					(current.length > 1 ? sepLen : 0);
				current.shift();
			}
		}
		current.push(piece);
		total += len + (current.length > 1 ? sepLen : 0);
	}

	const last = joinPieces(current, separator);
	if (last !== null) chunks.push(last);
	return chunks;
}

/** Recursively split `text`, descending the separator list for oversized parts. */
function splitRecursive(
	text: string,
	separators: readonly string[],
	size: number,
	overlap: number,
	measure: Measure,
): string[] {
	// Pick the first separator present in the text; fall back to char-level.
	let separator = separators[separators.length - 1] ?? "";
	let rest: readonly string[] = [];
	for (let i = 0; i < separators.length; i += 1) {
		const candidate = separators[i] ?? "";
		if (candidate === "") {
			separator = candidate;
			break;
		}
		if (text.includes(candidate)) {
			separator = candidate;
			rest = separators.slice(i + 1);
			break;
		}
	}

	const chunks: string[] = [];
	const goodPieces: string[] = [];

	for (const piece of splitOn(text, separator)) {
		if (measure(piece) < size) {
			goodPieces.push(piece);
			continue;
		}
		// Flush accumulated small pieces before handling the oversized one.
		if (goodPieces.length > 0) {
			chunks.push(
				...mergePieces(goodPieces, separator, size, overlap, measure),
			);
			goodPieces.length = 0;
		}
		if (rest.length === 0) {
			chunks.push(piece);
		} else {
			chunks.push(...splitRecursive(piece, rest, size, overlap, measure));
		}
	}

	if (goodPieces.length > 0) {
		chunks.push(...mergePieces(goodPieces, separator, size, overlap, measure));
	}
	return chunks;
}

/** Normalize line endings and trim, matching the original chunker. */
function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").trim();
}

function resolveOptions(options: ChunkOptions): {
	size: number;
	overlap: number;
	measure: Measure;
} {
	const size = Math.max(1, options.size ?? DEFAULT_SIZE);
	const overlap = Math.min(
		Math.max(0, options.overlap ?? DEFAULT_OVERLAP),
		size - 1,
	);
	return { size, overlap, measure: measureFor(options.unit ?? "char") };
}

/**
 * Split text into overlapping chunks along natural boundaries (paragraphs →
 * lines → words → characters), keeping each under `size` (measured in `unit`).
 * Deterministic and ordered: the same input always yields the same chunk list.
 * Whitespace-only input yields no chunks. Overlap is clamped to `size - 1` to
 * guarantee forward progress.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
	return chunkTextWithSpans(text, options).map((chunk) => chunk.content);
}

/**
 * Like {@link chunkText} but also returns each chunk's char offsets `[start, end)`
 * into the normalized text, so callers can store precise citation spans. Offsets
 * are located by scanning forward from the previous chunk's start, which keeps
 * repeated substrings mapped to distinct, monotonically-advancing positions.
 */
export function chunkTextWithSpans(
	text: string,
	options: ChunkOptions = {},
): ChunkSpan[] {
	const { size, overlap, measure } = resolveOptions(options);

	const normalized = normalizeText(text);
	if (normalized.length === 0) return [];

	const contents =
		measure(normalized) <= size
			? [normalized]
			: splitRecursive(normalized, SEPARATORS, size, overlap, measure);

	const spans: ChunkSpan[] = [];
	let searchFrom = 0;
	for (const content of contents) {
		let start = normalized.indexOf(content, searchFrom);
		if (start === -1) start = normalized.indexOf(content);
		if (start === -1) {
			// Should not happen — chunks are substrings of `normalized` — but stay
			// defensive rather than emit a negative offset.
			start = searchFrom;
		}
		const end = start + content.length;
		spans.push({ content, start, end });
		searchFrom = start + 1;
	}
	return spans;
}
