/**
 * Turn the chat wire format (text + base64 file parts) into AI SDK
 * `ModelMessage`s. Attachments are handled so they work across every model:
 *
 * - Images on a vision-capable model are forwarded as native image parts.
 * - Images on a text-only model, and all documents, are extracted to text
 *   server-side (officeparser / OCR / plain decode) and inlined as a labelled
 *   text block. This means even a text-only model "sees" an attachment.
 *
 * Safety: every file is size-capped before decoding, extracted text is length-
 * capped, and a per-file failure degrades to an inline note rather than failing
 * the whole request.
 */

import type {
	ImagePart,
	FilePart as ModelFilePart,
	ModelMessage,
	TextPart,
} from "@ai-sdk/provider-utils";
import type { ChatMessage } from "@/lib/ai/chat/sse";
import { extractText } from "@/lib/ai/rag/extract";

/** Largest single attachment we will decode (raw bytes). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Largest combined attachment payload across one request. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
/** Cap on extracted text inlined per document, to bound context growth. */
export const MAX_EXTRACTED_CHARS = 200_000;

const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"webp",
	"gif",
	"bmp",
	"tiff",
	"tif",
]);

function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function isImage(mediaType: string, filename: string): boolean {
	if (mediaType.startsWith("image/")) return true;
	return IMAGE_EXTENSIONS.has(extensionOf(filename));
}

/** IANA media type for an image extension, used when the client omits one. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
};

function imageMediaType(mediaType: string, filename: string): string {
	if (mediaType.startsWith("image/")) return mediaType;
	return IMAGE_MEDIA_TYPES[extensionOf(filename)] ?? "image/png";
}

/** Approximate decoded byte length of a base64 string without decoding it. */
function base64ByteLength(data: string): number {
	const trimmed = data.endsWith("==")
		? data.length - 2
		: data.endsWith("=")
			? data.length - 1
			: data.length;
	return Math.floor((trimmed * 3) / 4);
}

/**
 * Decode a buffer as UTF-8 only when it looks like text (no NUL bytes and a low
 * ratio of replacement characters). Lets us support arbitrary code/log/config
 * files that officeparser does not recognise, without misrendering binaries.
 */
function decodeIfText(buffer: Buffer): string | null {
	const sample = buffer.subarray(0, 4096);
	if (sample.includes(0)) return null;
	const text = buffer.toString("utf8");
	let replacements = 0;
	for (const char of text) {
		if (char === "\uFFFD") replacements++;
	}
	if (text.length > 0 && replacements / text.length > 0.1) return null;
	return text;
}

function truncate(text: string): string {
	if (text.length <= MAX_EXTRACTED_CHARS) return text;
	return `${text.slice(0, MAX_EXTRACTED_CHARS)}\n…[truncated]`;
}

/** Inline a document's extracted text as a labelled block. */
function documentBlock(name: string, body: string): TextPart {
	return {
		type: "text",
		text: `\n\n[Attachment: ${name}]\n${truncate(body)}`,
	};
}

/**
 * Inline OCR text recovered from an image on a model that cannot see images.
 * Labelled distinctly from a document so the model treats it as best-effort
 * recognised text (which may be imperfect) rather than the literal file, and
 * knows the visual content itself is unavailable to it.
 */
function imageOcrBlock(name: string, body: string): TextPart {
	return {
		type: "text",
		text:
			`\n\n[Image attachment: ${name} — this model cannot view images. ` +
			`Best-effort text recognised in the image (OCR, may be imperfect):]\n` +
			truncate(body),
	};
}

function noteBlock(name: string, reason: string): TextPart {
	return { type: "text", text: `\n\n[Attachment: ${name} — ${reason}]` };
}

/** Resolve one file part into one or more model content parts. */
async function resolveFilePart(
	part: { name: string; mediaType: string; data: string },
	opts: { supportsVision: boolean; signal?: AbortSignal },
): Promise<Array<TextPart | ImagePart | ModelFilePart>> {
	if (base64ByteLength(part.data) > MAX_ATTACHMENT_BYTES) {
		return [noteBlock(part.name, "skipped, file too large")];
	}

	let buffer: Buffer;
	try {
		buffer = Buffer.from(part.data, "base64");
	} catch {
		return [noteBlock(part.name, "could not be decoded")];
	}
	if (buffer.byteLength === 0) {
		return [noteBlock(part.name, "empty file")];
	}

	const image = isImage(part.mediaType, part.name);

	if (image) {
		if (opts.supportsVision) {
			return [
				{
					type: "image",
					image: buffer,
					mediaType: imageMediaType(part.mediaType, part.name),
				},
			];
		}
		// Text-only model: OCR is the only way it can access any image content, but
		// recognised text from a photo can be sparse or noisy, so label it honestly
		// and degrade to a clear note when nothing readable comes back.
		const ocr = await extractText(
			buffer,
			part.name,
			part.mediaType,
			opts.signal,
		);
		if (ocr.ok && ocr.text.trim().length > 0) {
			return [imageOcrBlock(part.name, ocr.text)];
		}
		return [
			noteBlock(
				part.name,
				"an image this model cannot view, with no readable text",
			),
		];
	}

	const extracted = await extractText(
		buffer,
		part.name,
		part.mediaType,
		opts.signal,
	);
	if (extracted.ok) {
		if (extracted.text.trim().length === 0) {
			return [noteBlock(part.name, "no readable text found")];
		}
		return [documentBlock(part.name, extracted.text)];
	}

	const decoded = decodeIfText(buffer);
	if (decoded && decoded.trim().length > 0) {
		return [documentBlock(part.name, decoded)];
	}

	return [noteBlock(part.name, "unsupported binary file")];
}

/**
 * Convert wire messages into AI SDK model messages, resolving file attachments.
 * Aborts decoding extra attachments once the total payload cap is exceeded.
 */
export async function buildModelMessages(
	messages: ChatMessage[],
	opts: { supportsVision: boolean; signal?: AbortSignal },
): Promise<ModelMessage[]> {
	const result: ModelMessage[] = [];
	let totalBytes = 0;

	for (const message of messages) {
		const textParts = message.parts.filter(
			(part): part is Extract<ChatMessage["parts"][number], { type: "text" }> =>
				part.type === "text",
		);
		const fileParts = message.parts.filter(
			(part): part is Extract<ChatMessage["parts"][number], { type: "file" }> =>
				part.type === "file",
		);

		const text = textParts
			.map((part) => part.text)
			.join("\n")
			.trim();

		// Files only ride on user turns; assistant/system stay plain text.
		if (message.role !== "user" || fileParts.length === 0) {
			result.push({ role: message.role, content: text });
			continue;
		}

		const content: Array<TextPart | ImagePart | ModelFilePart> = [];
		if (text.length > 0) content.push({ type: "text", text });

		for (const file of fileParts) {
			const size = base64ByteLength(file.data);
			if (totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES) {
				content.push(noteBlock(file.name, "skipped, attachment limit reached"));
				continue;
			}
			totalBytes += size;
			content.push(...(await resolveFilePart(file, opts)));
		}

		if (content.length === 0) content.push({ type: "text", text: "" });
		result.push({ role: "user", content });
	}

	return result;
}
