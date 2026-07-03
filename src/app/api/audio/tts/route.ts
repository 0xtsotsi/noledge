import { openai } from "@ai-sdk/openai";
import { experimental_generateSpeech as generateSpeech } from "ai";
import { z } from "zod";

export const runtime = "nodejs";

const SUPPORTED_VOICES = [
	"alloy",
	"shimmer",
	"echo",
	"fable",
	"onyx",
	"nova",
] as const;

const ttsRequestSchema = z.object({
	text: z.string().min(1).max(4096),
	voice: z.enum(SUPPORTED_VOICES).optional().default("alloy"),
});

/**
 * POST /api/audio/tts
 * Body: `{ text, voice? }`. Returns `{ audioBase64, mime, bytes }`.
 *
 * Uses OpenAI's `gpt-4o-mini-tts` (cheap tier, $0.015 / 1K chars as of
 * 2026-07-02 per OpenAI's pricing page). The generated audio is NOT
 * ingested into the RAG corpus — TTS is one-way playback of an answer that
 * already exists in the conversation history.
 */
export async function POST(request: Request): Promise<Response> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const parsed = ttsRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid request body", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	try {
		const { audio } = await generateSpeech({
			model: openai.speech("gpt-4o-mini-tts"),
			text: parsed.data.text,
			voice: parsed.data.voice,
		});
		return Response.json({
			audioBase64: audio.base64,
			mime: audio.mediaType || "audio/mpeg",
			bytes: audio.uint8Array.byteLength,
			format: audio.format,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: `TTS failed: ${message}` }, { status: 502 });
	}
}
