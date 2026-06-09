import type { AutomationConfig } from "./store";

/**
 * Timezone-aware schedule math, built on `Intl.DateTimeFormat` so no date library
 * is needed. The scheduler wakes periodically and asks {@link shouldRunNow}; a run
 * fires when the local hour in the configured timezone equals the configured hour
 * and we have not already run during this local calendar day.
 */

type LocalParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
};

/**
 * Decompose an instant into calendar parts (year/month/day/hour) as observed in
 * `timeZone`. Uses `hour12: false` and reads the formatted parts so DST shifts are
 * handled by the platform's tz database rather than manual offset math.
 */
function localParts(timeZone: string, at: Date): LocalParts {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
	});
	const parts = formatter.formatToParts(at);
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const value = parts.find((part) => part.type === type)?.value ?? "0";
		return Number.parseInt(value, 10);
	};
	// `hour: '2-digit'` with hour12:false can emit "24" at midnight on some
	// engines; normalize it to 0 so comparisons stay in 0..23.
	const hour = get("hour") % 24;
	return { year: get("year"), month: get("month"), day: get("day"), hour };
}

/** The current clock hour (0..23) observed in `timeZone`. */
export function currentHourInZone(
	timeZone: string,
	at: Date = new Date(),
): number {
	return localParts(timeZone, at).hour;
}

/** True when two instants fall on the same calendar day in `timeZone`. */
export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
	const pa = localParts(timeZone, a);
	const pb = localParts(timeZone, b);
	return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/**
 * Decide whether a scheduled poll should run now.
 *
 * Returns true when scheduling is enabled (`scheduleHour` set and `timezone`
 * present), the current local hour is at or past `scheduleHour`, and the last
 * run (if any) was on an earlier local day. Catch-up semantics: a laptop that
 * was asleep at the scheduled hour still runs on its first wake-up later that
 * day; the once-per-day guard stops the run repeating on subsequent wake-ups.
 */
export function shouldRunNow(
	config: AutomationConfig,
	now: Date = new Date(),
): boolean {
	const { scheduleHour, timezone, lastRunAt } = config;
	if (scheduleHour === null || !timezone) return false;
	if (scheduleHour < 0 || scheduleHour > 23) return false;

	let currentHour: number;
	try {
		currentHour = currentHourInZone(timezone, now);
	} catch {
		// Invalid timezone string — never fire rather than throw on the timer.
		return false;
	}
	if (currentHour < scheduleHour) return false;

	if (
		lastRunAt !== null &&
		isSameLocalDay(new Date(lastRunAt), now, timezone)
	) {
		return false;
	}
	return true;
}
