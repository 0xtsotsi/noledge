/**
 * Shared retry policy for the automation fetchers (paper HTTP, RSS feeds, and
 * article enrichment). One retry covers transient upstream hiccups — timeouts,
 * 429s, 5xx, dropped connections — that would otherwise make a whole source
 * contribute nothing for a poll cycle. Deterministic outcomes (4xx, parse/size
 * failures, caller cancellation) are never retried.
 */

/** Total attempts per request, including the first. */
export const RETRY_ATTEMPTS = 2;
/** Base backoff; multiplied by the attempt number for a simple linear ramp. */
export const RETRY_BACKOFF_MS = 1_000;

/** A 429 or 5xx is worth retrying; other statuses are deterministic. */
export function isTransientStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/** Abort-aware sleep: resolves early (without throwing) if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/** One attempt's outcome plus whether it's worth retrying. */
export type Attempt<T> = {
	value: T;
	retry: boolean;
	/** Server-requested wait (e.g. `Retry-After`); overrides the default backoff. */
	retryAfterMs?: number;
};

/**
 * Run `attempt` up to {@link RETRY_ATTEMPTS} times, backing off between tries
 * while `attempt` reports `retry: true`. Returns the last value either way, so
 * callers get a normal `Result` whether it eventually succeeded or exhausted
 * retries. Honors `signal`: an abort during backoff stops further attempts.
 */
export async function withRetry<T>(
	attempt: () => Promise<Attempt<T>>,
	options: { attempts?: number; backoffMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
	const attempts = options.attempts ?? RETRY_ATTEMPTS;
	const backoffMs = options.backoffMs ?? RETRY_BACKOFF_MS;

	let last = await attempt();
	for (let i = 2; i <= attempts && last.retry; i += 1) {
		await sleep(last.retryAfterMs ?? backoffMs * (i - 1), options.signal);
		if (options.signal?.aborted) break;
		last = await attempt();
	}
	return last.value;
}
