import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Json3Response, TranscriptResult } from "./helpers";
import { json3ToText } from "./helpers";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;

/** Cached path to the yt-dlp binary (null = not yet resolved). */
let ytdlpPath: string | null = null;

/**
 * Locate the yt-dlp binary on the system. On first call, checks PATH via
 * `which`; if missing, attempts auto-install via pip3 then brew. The result is
 * cached for the process lifetime.
 */
export async function ensureYtdlp(): Promise<string> {
	if (ytdlpPath) return ytdlpPath;

	// Fast path: already on PATH.
	try {
		const { stdout } = await execFileAsync("which", ["yt-dlp"], {
			timeout: 5_000,
		});
		ytdlpPath = stdout.trim();
		return ytdlpPath;
	} catch {
		// Not found — attempt auto-install.
	}

	// Attempt pip3 install.
	try {
		console.log("[ytdlp] yt-dlp not found; installing via pip3...");
		await execFileAsync("pip3", ["install", "--user", "yt-dlp"], {
			timeout: 60_000,
		});
		const { stdout } = await execFileAsync("which", ["yt-dlp"], {
			timeout: 5_000,
		});
		ytdlpPath = stdout.trim();
		console.log(`[ytdlp] installed at ${ytdlpPath}`);
		return ytdlpPath;
	} catch {
		// pip3 failed or unavailable.
	}

	// Attempt brew install (macOS).
	try {
		console.log("[ytdlp] pip3 failed; trying brew install...");
		await execFileAsync("brew", ["install", "yt-dlp"], { timeout: 120_000 });
		const { stdout } = await execFileAsync("which", ["yt-dlp"], {
			timeout: 5_000,
		});
		ytdlpPath = stdout.trim();
		console.log(`[ytdlp] installed at ${ytdlpPath}`);
		return ytdlpPath;
	} catch {
		// brew failed or unavailable.
	}

	throw new Error(
		"yt-dlp is not installed and auto-install failed. " +
			"Install manually: pip3 install yt-dlp  — or —  brew install yt-dlp",
	);
}

/**
 * Fetch a transcript for `videoId` using yt-dlp. Downloads subtitle data as
 * json3 into a temp directory, parses it, then cleans up. Returns a
 * {@link TranscriptResult} — never throws on network/parse failures.
 */
export async function fetchTranscriptViaYtdlp(
	videoId: string,
	language = "en",
	proxy?: string,
): Promise<TranscriptResult> {
	let binary: string;
	try {
		binary = await ensureYtdlp();
	} catch (error) {
		return {
			ok: false,
			skipped: true,
			reason:
				error instanceof Error
					? `yt-dlp unavailable: ${error.message}`
					: "yt-dlp unavailable.",
		};
	}

	const dir = join(tmpdir(), `ytdlp-${randomUUID()}`);
	await mkdir(dir, { recursive: true });

	try {
		await execFileAsync(
			binary,
			[
				"--write-auto-sub",
				"--sub-lang",
				language,
				"--skip-download",
				"--sub-format",
				"json3",
				"--no-warnings",
				...(proxy ? ["--proxy", proxy] : []),
				"-o",
				join(dir, "sub.%(ext)s"),
				`https://www.youtube.com/watch?v=${videoId}`,
			],
			{ timeout: TIMEOUT_MS },
		);

		// Find the output .json3 file.
		const files = await readdir(dir);
		const json3File = files.find((f) => f.endsWith(".json3"));
		if (!json3File) {
			return {
				ok: false,
				skipped: true,
				reason: `yt-dlp produced no subtitle file for ${videoId} (lang=${language}).`,
			};
		}

		const raw = await readFile(join(dir, json3File), "utf-8");
		const doc = JSON.parse(raw) as Json3Response;
		const text = json3ToText(doc);

		if (text.trim().length === 0) {
			return {
				ok: false,
				skipped: true,
				reason: `yt-dlp subtitle was empty for ${videoId}.`,
			};
		}

		return { ok: true, text };
	} catch (error) {
		return {
			ok: false,
			skipped: true,
			reason:
				error instanceof Error
					? `yt-dlp failed: ${error.message}`
					: "yt-dlp failed.",
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
