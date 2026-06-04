import type { Database } from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/ai/db/client";
import { addSource, findDuplicateSource } from "./store";

let db: Database | null = null;

afterEach(() => {
	db?.close();
	db = null;
});

describe("findDuplicateSource", () => {
	it("matches an existing RSS feed by url", () => {
		db = openDatabase(":memory:");
		addSource({ type: "rss", url: "https://b.example/feed.xml" }, db);

		expect(
			findDuplicateSource(
				{ type: "rss", url: "https://b.example/feed.xml" },
				db,
			),
		).toBeDefined();
		expect(
			findDuplicateSource(
				{ type: "rss", url: "https://other.example/feed" },
				db,
			),
		).toBeUndefined();
	});

	it("matches an existing YouTube channel by resolved identifier, not url", () => {
		db = openDatabase(":memory:");
		addSource(
			{
				type: "youtube",
				url: "https://youtube.com/@handle",
				identifier: "UC123",
			},
			db,
		);

		// A different URL form for the same channel resolves to the same id.
		expect(
			findDuplicateSource(
				{
					type: "youtube",
					url: "https://youtube.com/channel/UC123",
					identifier: "UC123",
				},
				db,
			),
		).toBeDefined();
		expect(
			findDuplicateSource(
				{
					type: "youtube",
					url: "https://youtube.com/@handle",
					identifier: "UC999",
				},
				db,
			),
		).toBeUndefined();
	});

	it("does not treat an RSS and YouTube source with the same url as duplicates", () => {
		db = openDatabase(":memory:");
		addSource({ type: "rss", url: "https://same.example" }, db);

		expect(
			findDuplicateSource({ type: "rss", url: "https://same.example" }, db),
		).toBeDefined();
		expect(
			findDuplicateSource(
				{ type: "youtube", url: "https://same.example", identifier: "UCx" },
				db,
			),
		).toBeUndefined();
	});
});
