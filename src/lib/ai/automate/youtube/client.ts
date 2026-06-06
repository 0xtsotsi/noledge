import { Innertube } from "youtubei.js";

/**
 * Process-wide singleton InnerTube client (LuanRT/YouTube.js). Creating a client
 * negotiates a session, so we do it once and share it across channel resolution,
 * video listing, and transcript fetching.
 *
 * `generate_session_locally` derives the session without an extra network round
 * trip. On failure the cached promise is cleared so a later call can retry rather
 * than being stuck with a rejected singleton.
 *
 * Set `YOUTUBE_COOKIES` in your environment with the cookie header value from a
 * logged-in browser session to reduce 429s and bypass age/region gates.
 */

let clientPromise: Promise<Innertube> | null = null;

export function getYoutubeClient(): Promise<Innertube> {
	if (!clientPromise) {
		const cookie = process.env.YOUTUBE_COOKIES;
		clientPromise = Innertube.create({
			generate_session_locally: true,
			...(cookie ? { cookie } : {}),
		}).catch((error: unknown) => {
			clientPromise = null;
			throw error;
		});
	}
	return clientPromise;
}

/** Drop the cached client so the next call re-creates (e.g. after cookie change). */
export function resetYoutubeClient(): void {
	clientPromise = null;
}
