"use client";

import {
	ArrowsClockwise,
	CircleNotch,
	GraduationCap,
	MonitorPlay,
	Plus,
	Rss,
} from "@phosphor-icons/react";
import { useState } from "react";
import { PapersSourcesDialog } from "@/components/automate/papers-sources-dialog";
import { RssSourcesDialog } from "@/components/automate/rss-sources-dialog";
import { ScheduleCard } from "@/components/automate/schedule-card";
import { YoutubeSourcesDialog } from "@/components/automate/youtube-sources-dialog";
import { Button } from "@/components/ui/button";
import { type PollSummary, useAutomation } from "@/hooks/use-automation";

function formatRelative(ms: number | null): string {
	if (ms === null) return "never";
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export default function AutomatePage(): React.JSX.Element {
	const automation = useAutomation();
	const [rssOpen, setRssOpen] = useState(false);
	const [youtubeOpen, setYoutubeOpen] = useState(false);
	const [papersOpen, setPapersOpen] = useState(false);
	const [syncing, setSyncing] = useState(false);
	const [syncResult, setSyncResult] = useState<string | null>(null);

	const sync = async (): Promise<void> => {
		setSyncing(true);
		setSyncResult(null);
		const result = await automation.syncNow();
		if (result.ok) {
			const s: PollSummary = result.value;
			setSyncResult(
				`Added ${s.added}, skipped ${s.skipped}${s.errors > 0 ? `, ${s.errors} error(s)` : ""}.`,
			);
		} else {
			setSyncResult(result.error);
		}
		setSyncing(false);
	};

	if (automation.loading || !automation.config) {
		return (
			<div className="flex size-full items-center justify-center bg-background">
				<CircleNotch className="size-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 px-6 py-8">
			<div className="flex items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Automate</h1>
					<p className="text-sm text-muted-foreground">
						Grow your knowledge base automatically from blogs and YouTube.
					</p>
				</div>
				<div className="flex flex-col items-center gap-1">
					<Button
						onClick={() => void sync()}
						disabled={syncing}
						className="shrink-0"
					>
						{syncing ? (
							<CircleNotch className="size-4 animate-spin" />
						) : (
							<ArrowsClockwise className="size-4" />
						)}
						Sync now
					</Button>
					<span className="text-xs text-muted-foreground">
						Last run: {formatRelative(automation.config.lastRunAt)}
					</span>
				</div>
			</div>

			{syncResult ? (
				<div className="rounded-lg border bg-muted/30 px-4 py-2.5 text-sm">
					{syncResult}
				</div>
			) : null}

			<ScheduleCard
				config={automation.config}
				onSave={automation.saveSchedule}
			/>

			<div className="grid gap-4 sm:grid-cols-2">
				<div className="relative flex flex-col gap-2 rounded-xl border p-5">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<Rss className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">Blog feeds (RSS)</h2>
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="-mr-2 h-7 px-2 text-muted-foreground"
							onClick={() => setRssOpen(true)}
						>
							<Plus className="size-4" />
							{automation.rss.length > 0 ? "Add or edit" : "Add"}
						</Button>
					</div>
					<p className="text-2xl font-semibold tabular-nums">
						{automation.rss.length}
					</p>
				</div>

				<div className="relative flex flex-col gap-2 rounded-xl border p-5">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<MonitorPlay className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">YouTube channels</h2>
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="-mr-2 h-7 px-2 text-muted-foreground"
							onClick={() => setYoutubeOpen(true)}
						>
							<Plus className="size-4" />
							{automation.youtube.length > 0 ? "Add or edit" : "Add"}
						</Button>
					</div>
					<p className="text-2xl font-semibold tabular-nums">
						{automation.youtube.length}
					</p>
				</div>

				<div className="relative flex flex-col gap-2 rounded-xl border p-5">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<GraduationCap className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">Research papers</h2>
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="-mr-2 h-7 px-2 text-muted-foreground"
							onClick={() => setPapersOpen(true)}
						>
							<Plus className="size-4" />
							{automation.papers.length > 0 ? "Add or edit" : "Add"}
						</Button>
					</div>
					<p className="text-2xl font-semibold tabular-nums">
						{automation.papers.length}
					</p>
				</div>
			</div>

			<RssSourcesDialog
				open={rssOpen}
				onOpenChange={setRssOpen}
				sources={automation.rss}
				testSource={automation.testSource}
				addSource={automation.addSource}
				removeSource={automation.removeSource}
			/>
			<YoutubeSourcesDialog
				open={youtubeOpen}
				onOpenChange={setYoutubeOpen}
				sources={automation.youtube}
				testSource={automation.testSource}
				addSource={automation.addSource}
				removeSource={automation.removeSource}
			/>
			<PapersSourcesDialog
				open={papersOpen}
				onOpenChange={setPapersOpen}
				sources={automation.papers}
				testSource={automation.testSource}
				addSource={automation.addSource}
				removeSource={automation.removeSource}
			/>
		</div>
	);
}
