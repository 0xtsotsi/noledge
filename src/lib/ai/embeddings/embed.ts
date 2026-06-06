import { createOpenAI } from "@ai-sdk/openai";
import { type EmbeddingModel, embedMany } from "ai";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/db/schema";
import { resolveProviderKey } from "@/lib/ai/models/provider-config";

/** OpenAI embedding model id locked to the dimension of the vec table. */
export const EMBEDDING_MODEL_ID = "text-embedding-3-small";

export type EmbedResult =
	| { ok: true; embeddings: number[][] }
	| { ok: false; error: string };

/**
 * OpenAI embeddings request limits. A single request accepts at most 2048 inputs
 * AND a bounded total token count; `text-embedding-3-small`'s ceiling is 300k, so
 * we batch under a safe margin. The AI SDK only splits by input count, so a long
 * document (hundreds of ~400-token chunks) would otherwise blow the token cap in
 * one oversized request. We pre-batch by both limits to keep every call legal.
 */
const MAX_INPUTS_PER_CALL = 2048;
const MAX_TOKENS_PER_CALL = 280_000;

/** Approximate token count for a string (≈4 chars per token), matching the chunker. */
function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Partition `values` into batches that each stay within both the input-count and
 * token-budget limits, preserving order. A single value larger than the token
 * budget still gets its own batch rather than being dropped — the provider will
 * reject it with a clear per-input error if it also exceeds the model's own cap.
 */
export function planEmbedBatches(
	values: string[],
	maxInputs: number = MAX_INPUTS_PER_CALL,
	maxTokens: number = MAX_TOKENS_PER_CALL,
): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let currentTokens = 0;

	for (const value of values) {
		const tokens = approxTokens(value);
		const wouldExceed =
			current.length >= maxInputs || currentTokens + tokens > maxTokens;
		if (wouldExceed && current.length > 0) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(value);
		currentTokens += tokens;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/** Resolve the configured embedding model. Throws if no OpenAI key is set. */
export function getEmbeddingModel(): EmbeddingModel {
	const { key } = resolveProviderKey("openai");
	if (!key) {
		throw new Error(
			"An OpenAI API key is required for embeddings (text-embedding-3-small).",
		);
	}
	const openai = createOpenAI({ apiKey: key });
	return openai.embedding(EMBEDDING_MODEL_ID);
}

/**
 * Embed a batch of strings. Returns a `Result` so callers can handle the common
 * "missing key / provider error" failure without try/catch.
 */
export async function embedTexts(
	values: string[],
	signal?: AbortSignal,
): Promise<EmbedResult> {
	if (values.length === 0) return { ok: true, embeddings: [] };

	try {
		const model = getEmbeddingModel();
		const embeddings: number[][] = [];

		// Embed batch-by-batch so each request honors OpenAI's input-count and
		// per-request token limits; results are concatenated in input order.
		for (const batch of planEmbedBatches(values)) {
			const { embeddings: batchEmbeddings } = await embedMany({
				model,
				values: batch,
				abortSignal: signal,
			});
			embeddings.push(...batchEmbeddings);
		}

		for (const vector of embeddings) {
			if (vector.length !== EMBEDDING_DIMENSIONS) {
				return {
					ok: false,
					error: `Expected ${EMBEDDING_DIMENSIONS}-dim embeddings, got ${vector.length}.`,
				};
			}
		}

		return { ok: true, embeddings };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Embedding failed.",
		};
	}
}

/** Encode an embedding vector for sqlite-vec binding (`float[]` blob). */
export function toVectorBlob(embedding: number[]): Buffer {
	return Buffer.from(new Float32Array(embedding).buffer);
}
