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
	RssPreview,
	useAutomation,
} from "@/hooks/use-automation";
import { notifyError, notifySuccess } from "@/lib/toast";
import { SourceList } from "./source-list";

type Api = ReturnType<typeof useAutomation>;

type RssSourcesDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sources: AutomationSourceItem[];
	testSource: Api["testSource"];
	addSource: Api["addSource"];
	removeSource: Api["removeSource"];
};

export function RssSourcesDialog({
	open,
	onOpenChange,
	sources,
	testSource,
	addSource,
	removeSource,
}: RssSourcesDialogProps): React.JSX.Element {
	const [url, setUrl] = useState("");
	const [testing, setTesting] = useState(false);
	const [adding, setAdding] = useState(false);
	const [preview, setPreview] = useState<RssPreview | null>(null);

	const reset = (): void => {
		setUrl("");
		setPreview(null);
	};

	const test = async (): Promise<void> => {
		setTesting(true);
		setPreview(null);
		const result = await testSource("rss", url.trim());
		if (result.ok) setPreview(result.value as RssPreview);
		else notifyError(result.error, "Could not load this feed.");
		setTesting(false);
	};

	const add = async (): Promise<void> => {
		setAdding(true);
		const result = await addSource("rss", url.trim());
		if (result.ok) {
			notifySuccess("Feed added.");
			reset();
		} else notifyError(result.error, "Could not add this feed.");
		setAdding(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!value) reset();
				onOpenChange(value);
			}}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Blog feeds (RSS)</DialogTitle>
					<DialogDescription>Add RSS or Atom feed URLs.</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<Input
							value={url}
							onChange={(event) => {
								setUrl(event.target.value);
								setPreview(null);
							}}
							placeholder="https://example.com/feed.xml"
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
								{preview.itemCount} items · latest:
							</p>
							<ul className="mt-1 list-inside list-disc text-muted-foreground">
								{preview.latestTitles.map((title) => (
									<li key={title} className="truncate">
										{title}
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>

				<SourceList
					sources={sources}
					onRemove={removeSource}
					emptyLabel="No feeds added yet."
				/>
			</DialogContent>
		</Dialog>
	);
}
