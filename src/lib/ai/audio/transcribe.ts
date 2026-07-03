import { openai } from "@ai-sdk/openai";
import { experimental_transcribe as transcribe } from "ai";

/**
 * Server-side transcription helper. Takes raw audio bytes (any container/codec
 * the OpenAI transcription endpoint accepts: webm/opus, mp4/m4a, wav, mp3,
 * flac), calls `gpt-4o-transcribe`, and returns the plain-text transcript.
 *
 * The transcription output becomes part of the RAG corpus when the caller
 * ingests it (see `ingestRecord` in `src/lib/ai/rag/ingest.ts`). BP-001's
 * UNTRUSTED_DATA framing and chunk-level provenance are applied downstream,
 * so the threat model still holds — a transcript is just text from the model.
 */
export async function transcribeAudio(audio: Uint8Array): Promise<string> {
	const { text } = await transcribe({
		model: openai.transcription("gpt-4o-transcribe"),
		audio,
	});
	return text.trim();
}
