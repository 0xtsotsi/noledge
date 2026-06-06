"use client";

import { CircleNotch } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type {
	AutomationSourceItem,
	useAutomation,
	YoutubePreview,
} from "@/hooks/use-automation";
import { notifyError, notifySuccess } from "@/lib/toast";
import { SourceList } from "./source-list";

type Api = ReturnType<typeof useAutomation>;

type YoutubeSourcesDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sources: AutomationSourceItem[];
	testSource: Api["testSource"];
	addSource: Api["addSource"];
	removeSource: Api["removeSource"];
};

export function YoutubeSourcesDialog({
	open,
	onOpenChange,
	sources,
	testSource,
	addSource,
	removeSource,
}: YoutubeSourcesDialogProps): React.JSX.Element {
	const [url, setUrl] = useState("");
	const [testing, setTesting] = useState(false);
	const [adding, setAdding] = useState(false);
	const [preview, setPreview] = useState<YoutubePreview | null>(null);

	const resetAdd = (): void => {
		setUrl("");
		setPreview(null);
	};

	const test = async (): Promise<void> => {
		setTesting(true);
		setPreview(null);
		const result = await testSource("youtube", url.trim());
		if (result.ok) setPreview(result.value as YoutubePreview);
		else notifyError(result.error, "Could not load this channel.");
		setTesting(false);
	};

	const add = async (): Promise<void> => {
		setAdding(true);
		const result = await addSource("youtube", url.trim());
		if (result.ok) {
			notifySuccess("Channel added.");
			resetAdd();
		} else notifyError(result.error, "Could not add this channel.");
		setAdding(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) resetAdd();
				onOpenChange(value);
			}}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>YouTube channels</DialogTitle>
					<DialogDescription>Add channels by URL or @handle.</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Input
							value={url}
							onChange={(event) => {
								setUrl(event.target.value);
								setPreview(null);
							}}
							placeholder="https://youtube.com/@channel or @channel"
							disabled={testing || adding}
						/>
						<Button
							variant="outline"
							size="sm"
							onClick={() => void test()}
							disabled={testing || adding || url.trim().length === 0}
						>
							{testing ? <CircleNotch className="size-4 animate-spin" /> : null}
							Test
						</Button>
						<Button
							size="sm"
							onClick={() => void add()}
							disabled={adding || !preview}
						>
							{adding ? <CircleNotch className="size-4 animate-spin" /> : null}
							Add
						</Button>
					</div>

					{preview ? (
						<div className="rounded-lg border bg-muted/30 p-3 text-xs">
							<p className="font-medium">{preview.title}</p>
							<p className="text-muted-foreground">
								{preview.videoCount} recent videos
								{preview.latestTitle ? ` · latest: ${preview.latestTitle}` : ""}
							</p>
							<p
								className={
									preview.transcriptOk
										? "mt-1 text-emerald-600 dark:text-emerald-500"
										: "mt-1 text-amber-600 dark:text-amber-500"
								}
							>
								{preview.transcriptOk
									? "Transcript probe succeeded."
									: `Transcript probe failed: ${preview.transcriptReason ?? "unknown"}`}
							</p>
						</div>
					) : null}
				</div>

				<SourceList
					sources={sources}
					onRemove={removeSource}
					emptyLabel="No channels added yet."
				/>
			</DialogContent>
		</Dialog>
	);
}
