import { describe, expect, it } from "vitest";
import { currentHourInZone, isSameLocalDay, shouldRunNow } from "./schedule";
import type { AutomationConfig } from "./store";

/** Build a config with sensible defaults for the field under test. */
function config(overrides: Partial<AutomationConfig> = {}): AutomationConfig {
	return {
		scheduleHour: 9,
		timezone: "Europe/London",
		lastRunAt: null,
		...overrides,
	};
}

describe("currentHourInZone", () => {
	it("reads the local hour across timezones for the same instant", () => {
		// 2025-06-01T12:00:00Z
		const at = new Date(Date.UTC(2025, 5, 1, 12, 0, 0));
		expect(currentHourInZone("UTC", at)).toBe(12);
		expect(currentHourInZone("Europe/London", at)).toBe(13); // BST = UTC+1
		expect(currentHourInZone("America/New_York", at)).toBe(8); // EDT = UTC-4
	});

	it("honors DST: London is UTC+0 in winter", () => {
		const winter = new Date(Date.UTC(2025, 0, 15, 12, 0, 0));
		expect(currentHourInZone("Europe/London", winter)).toBe(12);
	});
});

describe("isSameLocalDay", () => {
	it("treats instants across the UTC midnight but same local day as equal", () => {
		// 23:30 EDT and 00:30 EDT next UTC day are different local days.
		const a = new Date(Date.UTC(2025, 5, 1, 3, 30, 0)); // 23:30 EDT May 31
		const b = new Date(Date.UTC(2025, 5, 1, 5, 30, 0)); // 01:30 EDT Jun 1
		expect(isSameLocalDay(a, b, "America/New_York")).toBe(false);
	});

	it("returns true for two instants within the same local day", () => {
		const a = new Date(Date.UTC(2025, 5, 1, 13, 0, 0));
		const b = new Date(Date.UTC(2025, 5, 1, 20, 0, 0));
		expect(isSameLocalDay(a, b, "Europe/London")).toBe(true);
	});
});

describe("shouldRunNow", () => {
	it("fires when the local hour matches and there is no prior run", () => {
		// 09:30 BST = 08:30 UTC.
		const now = new Date(Date.UTC(2025, 5, 1, 8, 30, 0));
		expect(shouldRunNow(config({ scheduleHour: 9 }), now)).toBe(true);
	});

	it("does not fire before the scheduled hour", () => {
		const now = new Date(Date.UTC(2025, 5, 1, 8, 30, 0)); // 09:30 BST
		expect(shouldRunNow(config({ scheduleHour: 10 }), now)).toBe(false);
	});

	it("catches up after the scheduled hour when it hasn't run today", () => {
		// Laptop asleep at 09:00, woken at 11:30 BST = 10:30 UTC.
		const now = new Date(Date.UTC(2025, 5, 1, 10, 30, 0));
		expect(shouldRunNow(config({ scheduleHour: 9 }), now)).toBe(true);
	});

	it("does not catch up twice: a later wake-up the same day stays quiet", () => {
		const now = new Date(Date.UTC(2025, 5, 1, 14, 30, 0)); // 15:30 BST
		const caughtUpEarlier = new Date(Date.UTC(2025, 5, 1, 10, 30, 0)); // 11:30 BST
		expect(
			shouldRunNow(
				config({ scheduleHour: 9, lastRunAt: caughtUpEarlier.getTime() }),
				now,
			),
		).toBe(false);
	});

	it("does not fire twice in the same local day", () => {
		const now = new Date(Date.UTC(2025, 5, 1, 8, 30, 0)); // 09:30 BST
		const earlierToday = new Date(Date.UTC(2025, 5, 1, 8, 5, 0)); // 09:05 BST
		expect(
			shouldRunNow(
				config({ scheduleHour: 9, lastRunAt: earlierToday.getTime() }),
				now,
			),
		).toBe(false);
	});

	it("fires again the next day", () => {
		const now = new Date(Date.UTC(2025, 5, 2, 8, 30, 0)); // 09:30 BST Jun 2
		const yesterday = new Date(Date.UTC(2025, 5, 1, 8, 5, 0)); // 09:05 BST Jun 1
		expect(
			shouldRunNow(
				config({ scheduleHour: 9, lastRunAt: yesterday.getTime() }),
				now,
			),
		).toBe(true);
	});

	it("never fires when scheduling is disabled or tz missing", () => {
		const now = new Date(Date.UTC(2025, 5, 1, 8, 30, 0));
		expect(shouldRunNow(config({ scheduleHour: null }), now)).toBe(false);
		expect(shouldRunNow(config({ timezone: null }), now)).toBe(false);
	});

	it("never fires on an invalid timezone", () => {
		const now = new Date(Date.UTC(2025, 5, 1, 8, 30, 0));
		expect(shouldRunNow(config({ timezone: "Not/AZone" }), now)).toBe(false);
	});
});
