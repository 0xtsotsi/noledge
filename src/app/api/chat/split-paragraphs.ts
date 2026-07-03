/**
 * Split a markdown/answer text into paragraphs at blank-line boundaries.
 * Shared between the rewrite-paragraph API route and the front-end message
 * renderer so the indices the route uses match the ones the UI surfaces.
 */
export function splitParagraphs(text: string): string[] {
	return text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}
