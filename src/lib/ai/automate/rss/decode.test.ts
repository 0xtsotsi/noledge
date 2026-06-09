import { describe, expect, it } from "vitest";
import { decodeBody } from "./decode";

/** Build a Response body (copied into a fresh ArrayBuffer for BodyInit). */
function bytesOf(...parts: (string | number[])[]): ArrayBuffer {
	const joined = Buffer.concat(
		parts.map((part) =>
			typeof part === "string" ? Buffer.from(part, "ascii") : Buffer.from(part),
		),
	);
	const out = new ArrayBuffer(joined.byteLength);
	new Uint8Array(out).set(joined);
	return out;
}

describe("decodeBody", () => {
	it("honors the Content-Type charset parameter (ISO-8859-1)", async () => {
		// "café" with é as latin1 0xE9 — invalid UTF-8 on its own.
		const body = bytesOf("<rss><title>caf", [0xe9], "</title></rss>");
		const response = new Response(body, {
			headers: { "content-type": "application/rss+xml; charset=ISO-8859-1" },
		});
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toContain("café");
	});

	it("sniffs the XML prologue encoding when the header has none (GBK)", async () => {
		// GBK bytes 0xD6 0xD0 = 中.
		const body = bytesOf(
			'<?xml version="1.0" encoding="GBK"?><rss><title>',
			[0xd6, 0xd0],
			"</title></rss>",
		);
		const response = new Response(body, {
			headers: { "content-type": "application/xml" },
		});
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toContain("中");
	});

	it("sniffs an HTML meta charset", async () => {
		const body = bytesOf(
			'<html><head><meta charset="iso-8859-1"></head><body>caf',
			[0xe9],
			"</body></html>",
		);
		const response = new Response(body);
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toContain("café");
	});

	it("sniffs an HTML http-equiv content-type charset", async () => {
		const body = bytesOf(
			'<html><head><meta http-equiv="content-type" content="text/html; charset=iso-8859-1"></head><body>caf',
			[0xe9],
			"</body></html>",
		);
		const response = new Response(body);
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toContain("café");
	});

	it("falls back to UTF-8 on an unknown charset label", async () => {
		const response = new Response(bytesOf([...Buffer.from("héllo", "utf8")]), {
			headers: { "content-type": "text/html; charset=not-a-charset" },
		});
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("héllo");
	});

	it("defaults to UTF-8 with no charset information", async () => {
		const response = new Response(
			bytesOf([...Buffer.from("中文 café", "utf8")]),
		);
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("中文 café");
	});

	it("enforces the cap on raw bytes", async () => {
		const response = new Response(bytesOf([...Buffer.alloc(2048, 0x61)]));
		const result = await decodeBody(response, 1024);
		expect(result.ok).toBe(false);
	});
});
