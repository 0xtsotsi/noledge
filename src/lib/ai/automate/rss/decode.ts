/**
 * Charset-aware HTTP body decoding for feeds and articles. Many feeds (and
 * most older article pages) are not UTF-8; decoding them blindly mangles every
 * non-ASCII character. We honor the `Content-Type` charset parameter first,
 * then sniff the document prologue (`<?xml encoding=…?>`, `<meta charset>`,
 * `<meta http-equiv="content-type">`), and fall back to UTF-8.
 */

export type DecodeBodyResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

/** Charset parameter of a Content-Type header value, if present. */
function charsetFromContentType(contentType: string | null): string | null {
	if (!contentType) return null;
	const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
	return match?.[1] ?? null;
}

/**
 * Sniff a charset declaration from the first bytes of a document. The probe
 * window is decoded as latin1 (a 1:1 byte map, so the ASCII declaration text
 * survives any actual encoding).
 */
function sniffCharset(bytes: Uint8Array): string | null {
	const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
	const xml = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
	if (xml?.[1]) return xml[1];
	const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)["']?/i.exec(head);
	if (meta?.[1]) return meta[1];
	const httpEquiv =
		/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)[^"']*["']/i.exec(
			head,
		);
	if (httpEquiv?.[1]) return httpEquiv[1];
	return null;
}

const utf8Decoder = new TextDecoder("utf-8");

/**
 * Read a response body as text with charset detection, enforcing `maxBytes`
 * on the raw byte length (not the decoded string length). An unknown or
 * unsupported charset label falls back to UTF-8 rather than failing.
 */
export async function decodeBody(
	response: Response,
	maxBytes: number,
): Promise<DecodeBodyResult> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await response.arrayBuffer());
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to read response body.",
		};
	}
	if (bytes.byteLength > maxBytes) {
		return { ok: false, error: "Body exceeds the size limit." };
	}

	const charset =
		charsetFromContentType(response.headers.get("content-type")) ??
		sniffCharset(bytes);
	if (charset) {
		try {
			return { ok: true, text: new TextDecoder(charset).decode(bytes) };
		} catch {
			// Unknown label or malformed payload — fall through to UTF-8.
		}
	}
	return { ok: true, text: utf8Decoder.decode(bytes) };
}
