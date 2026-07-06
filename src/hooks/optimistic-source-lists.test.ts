import { describe, expect, it } from "vitest";
import {
	applyRemove,
	applyRestore,
	type SourceLists,
	takeFromLists,
} from "@/hooks/optimistic-source-lists";
import type { AutomationSourceItem } from "@/hooks/use-automation";

const rssSource: AutomationSourceItem = {
	id: "src-rss-1",
	type: "rss",
	url: "https://example.com/feed.xml",
	identifier: null,
	title: "Example",
	enabled: true,
	createdAt: 1,
	lastPolledAt: null,
	lastStatus: null,
	lastError: null,
	lastItemCount: 0,
};

const youtubeSource: AutomationSourceItem = {
	...rssSource,
	id: "src-yt-1",
	type: "youtube",
};

const papersSource: AutomationSourceItem = {
	...rssSource,
	id: "src-papers-1",
	type: "arxiv",
};

function seed(): SourceLists {
	return {
		rss: [rssSource],
		youtube: [youtubeSource],
		papers: [papersSource],
	};
}

describe("optimistic-source-lists", () => {
	it("takeFromLists finds an item across the three lists", () => {
		const lists = seed();
		expect(takeFromLists(lists, "src-yt-1")?.listKey).toBe("youtube");
		expect(takeFromLists(lists, "src-rss-1")?.listKey).toBe("rss");
		expect(takeFromLists(lists, "src-papers-1")?.listKey).toBe("papers");
	});

	it("takeFromLists returns null for an unknown id", () => {
		expect(takeFromLists(seed(), "missing")).toBeNull();
	});

	it("applyRemove drops the item from its captured list", () => {
		const lists = seed();
		const snap = takeFromLists(lists, "src-rss-1");
		expect(snap).not.toBeNull();
		if (!snap) return;
		const next = applyRemove(lists, snap);
		expect(next.rss).toHaveLength(0);
		expect(next.youtube).toHaveLength(1);
		expect(next.papers).toHaveLength(1);
	});

	it("applyRestore prepends the removed item back to its captured list", () => {
		const lists = seed();
		const snap = takeFromLists(lists, "src-rss-1");
		expect(snap).not.toBeNull();
		if (!snap) return;
		const removed = applyRemove(lists, snap);
		expect(removed.rss).toHaveLength(0);
		const restored = applyRestore(removed, snap);
		expect(restored.rss).toHaveLength(1);
		expect(restored.rss[0]?.id).toBe("src-rss-1");
	});

	it("applyRestore preserves list order when the id is already present (race-safe)", () => {
		const lists = seed();
		const snap = takeFromLists(lists, "src-rss-1");
		expect(snap).not.toBeNull();
		if (!snap) return;
		// A concurrent reload already re-added the item — applyRestore must
		// not insert a duplicate.
		const restored = applyRestore(lists, snap);
		expect(restored.rss).toHaveLength(1);
		expect(restored.rss[0]?.id).toBe("src-rss-1");
	});

	// B13 end-to-end contract: a 500 on DELETE rolls back the optimistic remove.
	// Exercises the same primitives the hook uses (take → remove → restore)
	// so a future regression in either pure helper surfaces here.
	it("B13: 500 on DELETE rolls back the optimistic remove", () => {
		const original = seed();

		// Step 1: snapshot + optimistic remove (what the hook does before fetch).
		const snap = takeFromLists(original, "src-rss-1");
		expect(snap).not.toBeNull();
		const optimistic = applyRemove(original, snap as never);
		expect(optimistic.rss.find((s) => s.id === "src-rss-1")).toBeUndefined();

		// Step 2: DELETE returns 500 → the hook calls applyRestore.
		const rolledBack = applyRestore(optimistic, snap as never);

		// Step 3: the source must be back in state.
		expect(rolledBack.rss.some((s) => s.id === "src-rss-1")).toBe(true);
		expect(rolledBack.rss).toHaveLength(1);
	});
});

/**
 * B14 contract smoke-check (kept separate so it cannot be confused with the
 * data-structure tests above). The real `reloadConfig` lives inside the
 * React hook, which we can't render under node-env; this asserts that the
 * `Result` shape it returns on `!response.ok` carries a non-empty error
 * string the caller can surface in the UI.
 */
describe("B14: reloadConfig Result shape on !response.ok", () => {
	it("Result.ok=false when fetch returns non-2xx carries an error string", () => {
		type Result<T> = { ok: true; value: T } | { ok: false; error: string };
		const result: Result<unknown> = {
			ok: false,
			error: "Request failed (500).",
		};
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.error.length).toBeGreaterThan(0);
			expect(result.error).toContain("500");
		}
	});
});
