import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractText } from "./extract";

const FIXTURES = join(__dirname, "__fixtures__");

function fixture(name: string): Buffer {
	return readFileSync(join(FIXTURES, name));
}

describe("extractText", () => {
	it("reads plain text directly", async () => {
		const result = await extractText(
			fixture("sample.txt"),
			"sample.txt",
			"text/plain",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toContain("quick brown fox");
	});

	it("reads markdown", async () => {
		const result = await extractText(
			fixture("sample.md"),
			"sample.md",
			"text/markdown",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text.toLowerCase()).toContain("markdown");
	});

	it("extracts text from a PDF", async () => {
		const result = await extractText(
			fixture("sample.pdf"),
			"sample.pdf",
			"application/pdf",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toContain("Hello world from a PDF");
	});

	it("reads JSON as text", async () => {
		const result = await extractText(
			fixture("sample.json"),
			"sample.json",
			"application/json",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text).toContain("JSONMARKER");
	});

	// Office/OOXML/ODF formats routed through officeparser. Each fixture embeds a
	// unique sentinel so we assert the format-specific text actually round-trips.
	const officeCases: { file: string; mime: string; marker: string }[] = [
		{
			file: "sample.docx",
			mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			marker: "WORDMARKER",
		},
		{
			file: "sample.pptx",
			mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			marker: "SLIDEMARKER",
		},
		{
			file: "sample.xlsx",
			mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			marker: "CELLMARKER",
		},
		{
			file: "sample.odt",
			mime: "application/vnd.oasis.opendocument.text",
			marker: "TEXTMARKER",
		},
		{
			file: "sample.odp",
			mime: "application/vnd.oasis.opendocument.presentation",
			marker: "PRESENTMARKER",
		},
		{
			file: "sample.ods",
			mime: "application/vnd.oasis.opendocument.spreadsheet",
			marker: "SPREADMARKER",
		},
		{ file: "sample.rtf", mime: "application/rtf", marker: "RICHMARKER" },
		{ file: "sample.html", mime: "text/html", marker: "HTMLMARKER" },
		{ file: "sample.csv", mime: "text/csv", marker: "CSVMARKER" },
	];

	for (const { file, mime, marker } of officeCases) {
		it(`extracts text from ${file}`, async () => {
			const result = await extractText(fixture(file), file, mime);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.text).toContain(marker);
		});
	}

	// Standalone image OCR across the supported raster formats.
	const imageCases: { file: string; mime: string }[] = [
		{ file: "hello.jpg", mime: "image/jpeg" },
		{ file: "hello.webp", mime: "image/webp" },
		{ file: "hello.tiff", mime: "image/tiff" },
	];

	for (const { file, mime } of imageCases) {
		it(`OCRs a standalone ${file}`, async () => {
			const result = await extractText(fixture(file), file, mime);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.text.toLowerCase()).toContain("hello");
		}, 120_000);
	}

	it("rejects unsupported types", async () => {
		const result = await extractText(
			Buffer.from([0, 1, 2, 3]),
			"data.bin",
			"application/octet-stream",
		);
		expect(result.ok).toBe(false);
	});

	it("OCRs a standalone image", async () => {
		const result = await extractText(
			fixture("hello.png"),
			"hello.png",
			"image/png",
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.text.toLowerCase()).toContain("hello");
	}, 120_000);

	it("OCRs a scanned (image-only, 1-bpp) PDF", async () => {
		const result = await extractText(
			fixture("scanned.pdf"),
			"scanned.pdf",
			"application/pdf",
		);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.text.toLowerCase()).toContain("scanned invoice");
	}, 120_000);
});
