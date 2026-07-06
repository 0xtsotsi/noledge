import type { AutomationSourceItem } from "@/hooks/use-automation";

export type SourceListKey = "rss" | "youtube" | "papers";

export type SourceLists = Record<SourceListKey, AutomationSourceItem[]>;

export type RemovedSnapshot = {
	item: AutomationSourceItem;
	listKey: SourceListKey;
};

/**
 * Pure strategy for `useAutomation::removeSource`. Lives in its own file so
 * the optimistic-delete + rollback logic can be tested under the node-env
 * vitest setup without pulling in a DOM harness.
 *
 * The hook wires this to `fetch(..., { method: 'DELETE' })` + its React
 * setters; this module does not know about React or the network.
 */
export function takeFromLists(
	lists: SourceLists,
	id: string,
): RemovedSnapshot | null {
	const listKeys: SourceListKey[] = ["rss", "youtube", "papers"];
	for (const listKey of listKeys) {
		const found = lists[listKey].find((s) => s.id === id);
		if (found) return { item: found, listKey };
	}
	return null;
}

/** Remove the snapshot's item from its captured list. */
export function applyRemove(
	lists: SourceLists,
	snapshot: RemovedSnapshot,
): SourceLists {
	return {
		...lists,
		[snapshot.listKey]: lists[snapshot.listKey].filter(
			(s) => s.id !== snapshot.item.id,
		),
	};
}

/**
 * Restore the snapshot's item to its original list (newest-first). If a
 * concurrent reload already re-added the same id, leave the list alone
 * (race-safety).
 */
export function applyRestore(
	lists: SourceLists,
	snapshot: RemovedSnapshot,
): SourceLists {
	const target = lists[snapshot.listKey];
	if (target.some((s) => s.id === snapshot.item.id)) return lists;
	return {
		...lists,
		[snapshot.listKey]: [snapshot.item, ...target],
	};
}
