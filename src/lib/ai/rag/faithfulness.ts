/**
 * Faithfulness judge — second LLM-as-judge pass after the main answer.
 *
 * Returns { score: 1-5, reasoning, unsupportedClaims[] }.
 *
 * If NO NOLEDGE_FAITHFULNESS_MODEL is configured, returns the default
 * { score: 3, reasoning: 'judge unavailable', unsupportedClaims: [] } so the
 * UI can still render a "Mixed (no judge)" badge without crashing.
 *
 * When a model is configured, calls Vercel AI SDK `generateObject` with a
 * Zod schema. Provider is auto-selected from the model name prefix
 * (claude-* → anthropic, otherwise openai).
 */

const DEFAULT_JUDGE = {
	score: 3,
	reasoning: "judge unavailable (no NOLEDGE_FAITHFULNESS_MODEL configured)",
	unsupportedClaims: [] as string[],
};

export type FaithfulnessResult = {
	score: number;
	reasoning: string;
	unsupportedClaims: string[];
};

const JUDGE_PROMPT =
	"You are a faithfulness judge for an AI assistant. Given the assistant's answer and the source " +
	"documents that grounded it, decide how well each claim in the answer is supported by the sources. " +
	"Output JSON with: " +
	'{ "score": number 1-5, "reasoning": string, "unsupportedClaims": string[] }. ' +
	"5 = every claim is directly supported by a source passage; 4 = most claims supported, minor gaps; " +
	"3 = some claims unverified; 2 = many claims unsupported; 1 = likely hallucinated. " +
	"In unsupportedClaims, quote the exact sentence(s) from the answer that are NOT supported by the sources. " +
	"Be strict: paraphrasing that introduces new facts counts as unsupported.";

export async function judgeFaithfulness(
	answer: string,
	sources: ReadonlyArray<{ title: string; content: string }>,
	model: string | undefined,
): Promise<FaithfulnessResult> {
	if (!model) return { ...DEFAULT_JUDGE };
	try {
		// Dynamic import so the bridge stays loadable in environments where
		// the AI SDK providers aren't installed.
		const { generateObject } = await import("ai");
		const { z } = await import("zod");
		const isClaude = model.startsWith("claude-");
		let sdkModel: import("ai").LanguageModel;
		if (isClaude) {
			const { anthropic } = await import("@ai-sdk/anthropic");
			sdkModel = anthropic(model);
		} else {
			const { openai } = await import("@ai-sdk/openai");
			sdkModel = openai(model);
		}
		const result = await generateObject({
			model: sdkModel,
			schema: z.object({
				score: z.number().int().min(1).max(5),
				reasoning: z.string(),
				unsupportedClaims: z.array(z.string()),
			}),
			prompt:
				JUDGE_PROMPT +
				"\n\n## Answer\n" +
				answer +
				"\n\n## Sources\n" +
				sources.map((s) => `### ${s.title}\n${s.content}`).join("\n\n"),
		});
		return {
			score: result.object.score,
			reasoning: result.object.reasoning,
			unsupportedClaims: result.object.unsupportedClaims,
		};
	} catch (err) {
		return {
			score: 3,
			reasoning: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
			unsupportedClaims: [],
		};
	}
}
