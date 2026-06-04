"use client";

import { CaretDown, CircleNotch } from "@phosphor-icons/react";
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
	SourceType,
	useAutomation,
} from "@/hooks/use-automation";
import { cn } from "@/lib/utils";
import { SourceList } from "./source-list";

/** Native `<select>` styled to match the app: appearance-none + a custom caret. */
function StyledSelect({
	className,
	children,
	...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
	return (
		<div className="relative inline-flex">
			<select
				{...props}
				className={cn(
					"h-9 appearance-none rounded-md border border-input bg-transparent pr-8 pl-3 text-sm shadow-xs outline-none transition-[color,box-shadow]",
					"focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
					"disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30",
					className,
				)}
			>
				{children}
			</select>
			<CaretDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
		</div>
	);
}

type Api = ReturnType<typeof useAutomation>;

type PapersSourcesDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sources: AutomationSourceItem[];
	testSource: Api["testSource"];
	addSource: Api["addSource"];
	removeSource: Api["removeSource"];
};

/** Paper providers selectable in the dialog (subset of {@link SourceType}). */
type Provider = "arxiv" | "openalex" | "pubmed" | "biorxiv" | "medrxiv";

const PROVIDERS: { value: Provider; label: string }[] = [
	{ value: "arxiv", label: "arXiv" },
	{ value: "openalex", label: "OpenAlex" },
	{ value: "pubmed", label: "PubMed" },
	{ value: "biorxiv", label: "bioRxiv" },
	{ value: "medrxiv", label: "medRxiv" },
];

const ARXIV_CATEGORIES = [
	"cs.AI",
	"cs.LG",
	"cs.CL",
	"cs.CV",
	"stat.ML",
	"q-bio.NC",
];

/** arXiv query mode. */
type ArxivMode = "category" | "keyword";

export function PapersSourcesDialog({
	open,
	onOpenChange,
	sources,
	testSource,
	addSource,
	removeSource,
}: PapersSourcesDialogProps): React.JSX.Element {
	const [provider, setProvider] = useState<Provider>("arxiv");
	const [arxivMode, setArxivMode] = useState<ArxivMode>("category");
	const [value, setValue] = useState("");
	const [testing, setTesting] = useState(false);
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [preview, setPreview] = useState<RssPreview | null>(null);

	const reset = (): void => {
		setValue("");
		setError(null);
		setPreview(null);
	};

	// bioRxiv/medRxiv take an optional category; everything else needs a value.
	const optionalValue = provider === "biorxiv" || provider === "medrxiv";
	const canSubmit = optionalValue || value.trim().length > 0;

	// Encode the request: paper `type` = provider; `url` = the query (bioRxiv blank
	// → "latest"); `identifier` = arXiv mode, null otherwise.
	const buildRequest = (): {
		type: SourceType;
		url: string;
		identifier: string | null;
	} => {
		const trimmed = value.trim();
		if (provider === "arxiv") {
			return { type: "arxiv", url: trimmed, identifier: arxivMode };
		}
		if (optionalValue) {
			return {
				type: provider,
				url: trimmed.length > 0 ? trimmed : "latest",
				identifier: null,
			};
		}
		return { type: provider, url: trimmed, identifier: null };
	};

	const test = async (): Promise<void> => {
		setTesting(true);
		setError(null);
		setPreview(null);
		const request = buildRequest();
		const result = await testSource(
			request.type,
			request.url,
			request.identifier,
		);
		if (result.ok) setPreview(result.value as RssPreview);
		else setError(result.error);
		setTesting(false);
	};

	const add = async (): Promise<void> => {
		setAdding(true);
		setError(null);
		const request = buildRequest();
		const result = await addSource(
			request.type,
			request.url,
			request.identifier,
		);
		if (result.ok) reset();
		else setError(result.error);
		setAdding(false);
	};

	const placeholder = ((): string => {
		if (provider === "arxiv") {
			return arxivMode === "category" ? "cs.AI" : "large language models";
		}
		if (provider === "pubmed") return "glp-1 weight loss";
		if (optionalValue) return "category (optional, e.g. neuroscience)";
		return "diffusion models";
	})();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) reset();
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Research papers</DialogTitle>
					<DialogDescription>Add academic sources.</DialogDescription>
				</DialogHeader>

				<div className="flex min-w-0 flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<StyledSelect
							value={provider}
							onChange={(event) => {
								setProvider(event.target.value as Provider);
								setPreview(null);
								setError(null);
							}}
							disabled={testing || adding}
							aria-label="Provider"
						>
							{PROVIDERS.map((item) => (
								<option key={item.value} value={item.value}>
									{item.label}
								</option>
							))}
						</StyledSelect>

						{provider === "arxiv" ? (
							<StyledSelect
								value={arxivMode}
								onChange={(event) => {
									setArxivMode(event.target.value as ArxivMode);
									setPreview(null);
								}}
								disabled={testing || adding}
								aria-label="arXiv query mode"
							>
								<option value="category">Category</option>
								<option value="keyword">Keyword</option>
							</StyledSelect>
						) : null}

						<Input
							value={value}
							onChange={(event) => {
								setValue(event.target.value);
								setPreview(null);
							}}
							placeholder={placeholder}
							disabled={testing || adding}
							list={
								provider === "arxiv" && arxivMode === "category"
									? "arxiv-categories"
									: undefined
							}
							className="min-w-40 flex-1"
						/>
						<datalist id="arxiv-categories">
							{ARXIV_CATEGORIES.map((code) => (
								<option key={code} value={code} />
							))}
						</datalist>
					</div>

					<div className="flex items-center justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => void test()}
							disabled={testing || adding || !canSubmit}
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

					{error ? <p className="text-xs text-destructive">{error}</p> : null}

					{preview ? (
						<div className="min-w-0 overflow-hidden rounded-lg border bg-muted/30 p-3 text-xs">
							<p className="truncate font-medium">{preview.title}</p>
							<p className="text-muted-foreground">
								{preview.itemCount} items · latest:
							</p>
							<ul className="mt-1 list-disc pl-4 text-muted-foreground">
								{preview.latestTitles.map((title) => (
									<li key={title} className="break-words">
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
					emptyLabel="No paper sources added yet."
				/>
			</DialogContent>
		</Dialog>
	);
}
