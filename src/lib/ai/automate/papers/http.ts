/**
 * Shared HTTP helper for the academic-paper providers. Sends a descriptive
 * User-Agent (arXiv/OpenAlex ask for one), follows redirects (arXiv 301s
 * http→https), and enforces an abort/timeout linked to an optional caller
 * `signal` so a slow upstream never stalls a poll. Lives in its own module to
 * keep `papers/index.ts` free of a provider↔index import cycle.
 */

const USER_AGENT = "noledge-automation/1.0 (+paper-poller)";
const FETCH_TIMEOUT_MS = 20_000;

export type HttpTextResult =
	| { ok: true; status: number; body: string }
	| { ok: false; error: string };

/** Fetch a URL as text. Network/timeout failures return a `Result`. */
export async function httpText(
	url: string,
	options: { accept?: string; signal?: AbortSignal } = {},
): Promise<HttpTextResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	if (options.signal) {
		options.signal.addEventListener("abort", () => controller.abort(), {
			once: true,
		});
	}
	try {
		const response = await fetch(url, {
			headers: {
				Accept: options.accept ?? "application/json, text/xml, */*; q=0.8",
				"User-Agent": USER_AGENT,
			},
			redirect: "follow",
			signal: controller.signal,
		});
		const body = await response.text();
		return { ok: true, status: response.status, body };
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			return { ok: false, error: "Request timed out." };
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Request failed.",
		};
	} finally {
		clearTimeout(timer);
	}
}
