import { transcribeAudio } from "@/lib/ai/audio/transcribe";

export const runtime = "nodejs";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB cap — matches the chat attachment cap.

/**
 * POST /api/audio/transcribe
 * Body: `audio/webm` (or other audio mime) raw bytes. The browser's
 * `MediaRecorder` ships `audio/webm; codecs=opus` by default; OpenAI's
 * transcription endpoint accepts webm/opus, mp4/m4a, wav, mp3, and flac.
 *
 * Returns `{ text }`. The caller (a front component) decides where to insert
 * the text (a Note body, a chat input, a task title). Because the result
 * becomes human-typed text, we do NOT add it to the RAG corpus here — that
 * happens via the existing ingest path, which already applies BP-001's
 * chunk framing and UNTRUSTED_DATA guard downstream.
 */
export async function POST(request: Request): Promise<Response> {
	const contentLength = Number.parseInt(
		request.headers.get("content-length") ?? "0",
		10,
	);
	if (Number.isFinite(contentLength) && contentLength > MAX_BYTES) {
		return Response.json(
			{ error: `Audio payload too large (max ${MAX_BYTES} bytes).` },
			{ status: 413 },
		);
	}

	const buffer = new Uint8Array(await request.arrayBuffer());
	if (buffer.byteLength === 0) {
		return Response.json({ error: "Empty audio body." }, { status: 400 });
	}
	if (buffer.byteLength > MAX_BYTES) {
		return Response.json(
			{ error: `Audio payload too large (max ${MAX_BYTES} bytes).` },
			{ status: 413 },
		);
	}

	try {
		const text = await transcribeAudio(buffer);
		return Response.json({ text });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json(
			{ error: `Transcription failed: ${message}` },
			{ status: 502 },
		);
	}
}
