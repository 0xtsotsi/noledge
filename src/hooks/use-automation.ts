"use client";

import { useCallback, useEffect, useState } from "react";

export type SourceType =
	| "rss"
	| "youtube"
	| "arxiv"
	| "openalex"
	| "pubmed"
	| "biorxiv"
	| "medrxiv";

export type AutomationSourceItem = {
	id: string;
	type: SourceType;
	url: string;
	identifier: string | null;
	title: string | null;
	enabled: boolean;
	createdAt: number;
	lastPolledAt: number | null;
	lastStatus: "ok" | "error" | "partial" | null;
	lastError: string | null;
	lastItemCount: number;
};

export type AutomationConfigState = {
	scheduleHour: number | null;
	timezone: string | null;
	lastRunAt: number | null;
};

export type RssPreview = {
	title: string;
	itemCount: number;
	latestTitles: string[];
};

export type YoutubePreview = {
	title: string;
	videoCount: number;
	latestTitle: string | null;
	transcriptOk: boolean;
	transcriptReason: string | null;
};

export type PollSummary = {
	added: number;
	skipped: number;
	errors: number;
	perSource: {
		sourceId: string;
		type: SourceType;
		title: string;
		added: number;
		skipped: number;
		status: "ok" | "error" | "partial";
		error?: string;
	}[];
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function readError(response: Response): Promise<string> {
	try {
		const data = (await response.json()) as { error?: string };
		return data.error ?? `Request failed (${response.status}).`;
	} catch {
		return `Request failed (${response.status}).`;
	}
}

export function useAutomation(): {
	config: AutomationConfigState | null;
	rss: AutomationSourceItem[];
	youtube: AutomationSourceItem[];
	papers: AutomationSourceItem[];
	loading: boolean;
	reloadConfig: () => Promise<void>;
	reloadSources: () => Promise<void>;
	saveSchedule: (
		scheduleHour: number | null,
		timezone: string | null,
	) => Promise<Result<AutomationConfigState>>;
	testSource: (
		type: SourceType,
		url: string,
		identifier?: string | null,
	) => Promise<Result<RssPreview | YoutubePreview>>;
	addSource: (
		type: SourceType,
		url: string,
		identifier?: string | null,
	) => Promise<Result<AutomationSourceItem>>;
	removeSource: (id: string) => Promise<void>;
	syncNow: () => Promise<Result<PollSummary>>;
} {
	const [config, setConfig] = useState<AutomationConfigState | null>(null);
	const [rss, setRss] = useState<AutomationSourceItem[]>([]);
	const [youtube, setYoutube] = useState<AutomationSourceItem[]>([]);
	const [papers, setPapers] = useState<AutomationSourceItem[]>([]);
	const [loading, setLoading] = useState(true);

	const reloadConfig = useCallback(async (): Promise<void> => {
		const response = await fetch("/api/automate/config");
		if (response.ok)
			setConfig((await response.json()) as AutomationConfigState);
	}, []);

	const reloadSources = useCallback(async (): Promise<void> => {
		const response = await fetch("/api/automate/sources");
		if (response.ok) {
			const data = (await response.json()) as {
				rss: AutomationSourceItem[];
				youtube: AutomationSourceItem[];
				papers: AutomationSourceItem[];
			};
			setRss(data.rss);
			setYoutube(data.youtube);
			setPapers(data.papers);
		}
	}, []);

	useEffect(() => {
		void (async () => {
			await Promise.all([reloadConfig(), reloadSources()]);
			setLoading(false);
		})();
	}, [reloadConfig, reloadSources]);

	const saveSchedule = useCallback(
		async (
			scheduleHour: number | null,
			timezone: string | null,
		): Promise<Result<AutomationConfigState>> => {
			const response = await fetch("/api/automate/config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ scheduleHour, timezone }),
			});
			if (!response.ok) return { ok: false, error: await readError(response) };
			const value = (await response.json()) as AutomationConfigState;
			setConfig(value);
			return { ok: true, value };
		},
		[],
	);

	const testSource = useCallback(
		async (
			type: SourceType,
			url: string,
			identifier?: string | null,
		): Promise<Result<RssPreview | YoutubePreview>> => {
			const response = await fetch("/api/automate/sources/test", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type, url, identifier }),
			});
			if (!response.ok) return { ok: false, error: await readError(response) };
			const data = (await response.json()) as {
				preview: RssPreview | YoutubePreview;
			};
			return { ok: true, value: data.preview };
		},
		[],
	);

	const addSource = useCallback(
		async (
			type: SourceType,
			url: string,
			identifier?: string | null,
		): Promise<Result<AutomationSourceItem>> => {
			const response = await fetch("/api/automate/sources", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type, url, identifier }),
			});
			if (!response.ok) return { ok: false, error: await readError(response) };
			const data = (await response.json()) as { source: AutomationSourceItem };
			if (data.source.type === "rss") {
				setRss((prev) => [data.source, ...prev]);
			} else if (data.source.type === "youtube") {
				setYoutube((prev) => [data.source, ...prev]);
			} else {
				setPapers((prev) => [data.source, ...prev]);
			}
			return { ok: true, value: data.source };
		},
		[],
	);

	const removeSource = useCallback(async (id: string): Promise<void> => {
		await fetch(`/api/automate/sources?id=${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		setRss((prev) => prev.filter((s) => s.id !== id));
		setYoutube((prev) => prev.filter((s) => s.id !== id));
		setPapers((prev) => prev.filter((s) => s.id !== id));
	}, []);

	const syncNow = useCallback(async (): Promise<Result<PollSummary>> => {
		const response = await fetch("/api/automate/run", { method: "POST" });
		if (!response.ok) return { ok: false, error: await readError(response) };
		const value = (await response.json()) as PollSummary;
		await Promise.all([reloadConfig(), reloadSources()]);
		return { ok: true, value };
	}, [reloadConfig, reloadSources]);

	return {
		config,
		rss,
		youtube,
		papers,
		loading,
		reloadConfig,
		reloadSources,
		saveSchedule,
		testSource,
		addSource,
		removeSource,
		syncNow,
	};
}
