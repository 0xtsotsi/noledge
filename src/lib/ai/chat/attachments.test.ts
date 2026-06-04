import { describe, expect, it } from "vitest";
import { buildModelMessages } from "./attachments";
import type { ChatMessage } from "./sse";

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function userMessage(parts: ChatMessage["parts"]): ChatMessage {
	return { id: "m1", role: "user", parts };
}

describe("buildModelMessages", () => {
	it("keeps plain text messages as a string", async () => {
		const result = await buildModelMessages(
			[userMessage([{ type: "text", text: "hello" }])],
			{ supportsVision: true },
		);
		expect(result).toEqual([{ role: "user", content: "hello" }]);
	});

	it("inlines a text attachment's contents for any model", async () => {
		const result = await buildModelMessages(
			[
				userMessage([
					{ type: "text", text: "summarize" },
					{
						type: "file",
						name: "notes.txt",
						mediaType: "text/plain",
						data: b64("the quick brown fox"),
					},
				]),
			],
			{ supportsVision: false },
		);

		expect(result).toHaveLength(1);
		const content = result[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		const parts = content as { type: string; text?: string }[];
		expect(parts[0]).toEqual({ type: "text", text: "summarize" });
		expect(parts[1]?.type).toBe("text");
		expect(parts[1]?.text).toContain("[Attachment: notes.txt]");
		expect(parts[1]?.text).toContain("the quick brown fox");
	});

	it("decodes unknown text-like files via the utf-8 fallback", async () => {
		const result = await buildModelMessages(
			[
				userMessage([
					{
						type: "file",
						name: "main.rs",
						mediaType: "application/octet-stream",
						data: b64('fn main() { println!("hi"); }'),
					},
				]),
			],
			{ supportsVision: false },
		);
		const parts = result[0]?.content as { type: string; text?: string }[];
		expect(parts[0]?.text).toContain("fn main()");
	});

	it("forwards images as native parts on a vision model", async () => {
		const pngPixel =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		const result = await buildModelMessages(
			[
				userMessage([
					{
						type: "file",
						name: "pixel.png",
						mediaType: "image/png",
						data: pngPixel,
					},
				]),
			],
			{ supportsVision: true },
		);
		const parts = result[0]?.content as { type: string; mediaType?: string }[];
		expect(parts[0]?.type).toBe("image");
		expect(parts[0]?.mediaType).toBe("image/png");
	});

	it("does not forward images natively on a text-only model", async () => {
		// A 1x1 png yields no OCR text, exercising the honest no-readable-text note
		// instead of emitting a native image part or garbled OCR.
		const pngPixel =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		const result = await buildModelMessages(
			[
				userMessage([
					{
						type: "file",
						name: "photo.png",
						mediaType: "image/png",
						data: pngPixel,
					},
				]),
			],
			{ supportsVision: false },
		);
		const parts = result[0]?.content as { type: string; text?: string }[];
		expect(parts.every((p) => p.type === "text")).toBe(true);
		expect(parts[0]?.text).toContain("cannot view");
	});

	it("notes when an attachment exceeds the size cap", async () => {
		// 21 MB of base64 data decodes to > 20 MB.
		const big = "A".repeat(21 * 1024 * 1024 * 2);
		const result = await buildModelMessages(
			[
				userMessage([
					{
						type: "file",
						name: "huge.bin",
						mediaType: "application/octet-stream",
						data: big,
					},
				]),
			],
			{ supportsVision: false },
		);
		const parts = result[0]?.content as { type: string; text?: string }[];
		expect(parts[0]?.text).toContain("too large");
	});
});
