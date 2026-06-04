"use client";

import type { Icon } from "@phosphor-icons/react";
import {
	CaretDown,
	CaretLeft,
	CaretRight,
	CaretUp,
	CircleNotch,
	FileImage,
	FilePdf,
	FileText,
	FileXls,
	MonitorPlay,
	Trash,
	Upload,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { UploadDialog } from "@/components/knowledge/upload-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type DocumentItem = {
	id: string;
	title: string;
	filename: string;
	mime: string;
	bytes: number;
	createdAt: number;
	chunks: number;
	sourceId: string | null;
	sourceUrl: string | null;
};

type DocumentTypeFilter =
	| "all"
	| "article"
	| "video"
	| "paper"
	| "pdf"
	| "image"
	| "spreadsheet"
	| "text";

type DocumentSortKey = "name" | "type" | "chunks" | "size" | "added";
type DocumentSortDirection = "asc" | "desc";

type KnowledgeSort = {
	key: DocumentSortKey;
	direction: DocumentSortDirection;
};

type TypeFilterOption = {
	value: DocumentTypeFilter;
	label: string;
};

type DocumentTypeCounts = Record<DocumentTypeFilter, number>;

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function isYoutubeUrl(url: string | null): boolean {
	if (!url) return false;
	return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function isPaperUrl(url: string | null): boolean {
	if (!url) return false;
	return /(?:arxiv\.org|openalex\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|biorxiv\.org|medrxiv\.org)/i.test(
		url,
	);
}

/**
 * Human label for the Type column. Automation-sourced docs read from provenance
 * (YouTube → “Video”, any other feed source → “Article”); manual uploads fall back
 * to the file extension, since their filename is a real file name.
 */
function typeLabel(doc: DocumentItem): string {
	if (isYoutubeUrl(doc.sourceUrl)) return "Video";
	if (isPaperUrl(doc.sourceUrl)) return "Paper";
	if (doc.sourceId) return "Article";
	const dot = doc.filename.lastIndexOf(".");
	return dot === -1 ? "—" : doc.filename.slice(dot + 1).toUpperCase();
}

function iconFor(doc: DocumentItem): Icon {
	if (isYoutubeUrl(doc.sourceUrl)) return MonitorPlay;
	const ext = doc.filename.toLowerCase().split(".").pop() ?? "";
	if (doc.mime.startsWith("image/")) return FileImage;
	if (["xlsx", "ods", "csv"].includes(ext)) return FileXls;
	if (doc.mime === "application/pdf" || ext === "pdf") return FilePdf;
	return FileText;
}

const PAGE_SIZE = 25;

const TYPE_FILTER_OPTIONS = [
	{ value: "all", label: "All types" },
	{ value: "article", label: "Articles" },
	{ value: "video", label: "Videos" },
	{ value: "paper", label: "Papers" },
	{ value: "pdf", label: "PDFs" },
	{ value: "image", label: "Images" },
	{ value: "spreadsheet", label: "Spreadsheets" },
	{ value: "text", label: "Text & docs" },
] satisfies TypeFilterOption[];

const EMPTY_TYPE_COUNTS = Object.fromEntries(
	TYPE_FILTER_OPTIONS.map((option) => [option.value, 0]),
) as DocumentTypeCounts;

function typeFilterLabel(value: DocumentTypeFilter): string {
	return (
		TYPE_FILTER_OPTIONS.find((option) => option.value === value)?.label ??
		"All types"
	);
}

function defaultDirectionFor(key: DocumentSortKey): DocumentSortDirection {
	if (key === "chunks" || key === "size") return "desc";
	return "asc";
}

function nextSortFor(
	current: KnowledgeSort,
	key: DocumentSortKey,
): KnowledgeSort {
	if (current.key !== key) {
		return { key, direction: defaultDirectionFor(key) };
	}
	return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

type SortHeaderProps = {
	label: string;
	sortKey: DocumentSortKey;
	current: KnowledgeSort;
	onSort: (key: DocumentSortKey) => void;
	align?: "left" | "right";
	className?: string;
};

function SortHeader({
	label,
	sortKey,
	current,
	onSort,
	align = "left",
	className,
}: SortHeaderProps): React.JSX.Element {
	const active = current.key === sortKey;
	const Icon = active && current.direction === "asc" ? CaretUp : CaretDown;
	return (
		<th
			className={cn("px-4 py-2.5 font-medium", className)}
			aria-sort={
				active
					? current.direction === "asc"
						? "ascending"
						: "descending"
					: "none"
			}
		>
			<button
				type="button"
				className={cn(
					"inline-flex items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
					align === "right" && "float-right",
					active && "text-foreground",
				)}
				onClick={() => onSort(sortKey)}
			>
				{label}
				<Icon className={cn("size-3.5", !active && "opacity-45")} />
			</button>
		</th>
	);
}

export default function KnowledgePage(): React.JSX.Element {
	const [documents, setDocuments] = useState<DocumentItem[]>([]);
	const [total, setTotal] = useState(0);
	const [page, setPage] = useState(0);
	const [loading, setLoading] = useState(true);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [uploadOpen, setUploadOpen] = useState(false);
	const [typeFilter, setTypeFilter] = useState<DocumentTypeFilter>("all");
	const [typeCounts, setTypeCounts] =
		useState<DocumentTypeCounts>(EMPTY_TYPE_COUNTS);
	const [sort, setSort] = useState<KnowledgeSort>({
		key: "added",
		direction: "desc",
	});

	const load = useCallback(
		async (pageIndex: number): Promise<void> => {
			setLoading(true);
			try {
				const offset = pageIndex * PAGE_SIZE;
				const params = new URLSearchParams({
					limit: String(PAGE_SIZE),
					offset: String(offset),
					type: typeFilter,
					sort: sort.key,
					direction: sort.direction,
				});
				const response = await fetch(`/api/documents?${params.toString()}`);
				const data = (await response.json()) as {
					documents: DocumentItem[];
					total: number;
					counts: DocumentTypeCounts;
				};
				setDocuments(data.documents);
				setTotal(data.total);
				setTypeCounts(data.counts);
			} catch {
				setDocuments([]);
				setTotal(0);
				setTypeCounts(EMPTY_TYPE_COUNTS);
			} finally {
				setLoading(false);
			}
		},
		[sort.direction, sort.key, typeFilter],
	);

	useEffect(() => {
		void load(page);
	}, [load, page]);

	const remove = useCallback(
		async (id: string): Promise<void> => {
			setDeleting(id);
			try {
				await fetch(`/api/documents?id=${encodeURIComponent(id)}`, {
					method: "DELETE",
				});
				// Reload so counts and the page slice stay correct; step back a page
				// if we just removed the last row on a non-first page.
				const remaining = total - 1;
				const lastPage = Math.max(0, Math.ceil(remaining / PAGE_SIZE) - 1);
				const nextPage = Math.min(page, lastPage);
				if (nextPage === page) await load(page);
				else setPage(nextPage);
			} finally {
				setDeleting(null);
			}
		},
		[load, page, total],
	);

	const updateTypeFilter = useCallback((value: string): void => {
		setTypeFilter(value as DocumentTypeFilter);
		setPage(0);
	}, []);

	const updateSort = useCallback((key: DocumentSortKey): void => {
		setSort((current) => nextSortFor(current, key));
		setPage(0);
	}, []);

	const selectedTypeCount = typeCounts[typeFilter];
	const isEmpty = !loading && total === 0;
	const hasActiveFilter = typeFilter !== "all";
	const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
	const rangeEnd = Math.min(page * PAGE_SIZE + documents.length, total);

	return (
		<div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 px-6 py-8">
			<div className="flex items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1>
					<p className="text-sm text-muted-foreground">
						The tasty stash of stuff Noledge has learned from.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" className="min-w-40 justify-between">
								<span>{typeFilterLabel(typeFilter)}</span>
								<span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">
									{selectedTypeCount}
								</span>
								<CaretDown className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-48">
							<DropdownMenuLabel>Filter by type</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={typeFilter}
								onValueChange={updateTypeFilter}
							>
								{TYPE_FILTER_OPTIONS.map((option) => (
									<DropdownMenuRadioItem
										key={option.value}
										value={option.value}
										showIndicator={false}
										className="justify-between data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground"
									>
										<span>{option.label}</span>
										<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground tabular-nums">
											{typeCounts[option.value]}
										</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>

					<Button onClick={() => setUploadOpen(true)}>
						<Upload className="size-4" />
						Upload
					</Button>
				</div>
			</div>

			{loading ? (
				<div className="flex flex-1 items-center justify-center">
					<CircleNotch className="size-6 animate-spin text-muted-foreground" />
				</div>
			) : isEmpty ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-center">
					<p className="text-sm font-medium">
						{hasActiveFilter ? "No matching knowledge" : "No knowledge yet"}
					</p>
					<p className="text-xs text-muted-foreground">
						{hasActiveFilter
							? "Try another type filter or upload a matching document."
							: "Upload documents — PDF, Office, text, and images (OCR)"}
					</p>
				</div>
			) : (
				<div className="overflow-hidden rounded-xl border">
					<table className="w-full table-fixed text-sm">
						<thead>
							<tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
								<SortHeader
									label="Name"
									sortKey="name"
									current={sort}
									onSort={updateSort}
								/>
								<SortHeader
									label="Type"
									sortKey="type"
									current={sort}
									onSort={updateSort}
									className="w-24"
								/>
								<SortHeader
									label="Chunks"
									sortKey="chunks"
									current={sort}
									onSort={updateSort}
									align="right"
									className="w-24 text-right"
								/>
								<SortHeader
									label="Size"
									sortKey="size"
									current={sort}
									onSort={updateSort}
									align="right"
									className="w-24 text-right"
								/>
								<SortHeader
									label="Added"
									sortKey="added"
									current={sort}
									onSort={updateSort}
									className="w-32"
								/>
								<th className="w-12 px-4 py-2.5" />
							</tr>
						</thead>
						<tbody>
							{documents.map((doc) => {
								const Icon = iconFor(doc);
								return (
									<tr
										key={doc.id}
										className="group border-b last:border-0 transition-colors hover:bg-accent/40"
									>
										<td className="px-4 py-3">
											<div className="flex items-center gap-3">
												<Icon className="size-5 shrink-0 text-muted-foreground" />
												<div className="min-w-0">
													<p className="truncate font-medium">{doc.title}</p>
													<p className="truncate text-xs text-muted-foreground">
														{doc.filename}
													</p>
												</div>
											</div>
										</td>
										<td className="px-4 py-3 text-muted-foreground">
											{typeLabel(doc)}
										</td>
										<td className="px-4 py-3 text-right tabular-nums">
											{doc.chunks}
										</td>
										<td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
											{formatBytes(doc.bytes)}
										</td>
										<td className="px-4 py-3 text-muted-foreground">
											{formatDate(doc.createdAt)}
										</td>
										<td className="px-4 py-3 text-right">
											<Button
												variant="ghost"
												size="icon"
												type="button"
												className="size-8 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
												aria-label={`Delete ${doc.title}`}
												disabled={deleting === doc.id}
												onClick={() => {
													void remove(doc.id);
												}}
											>
												{deleting === doc.id ? (
													<CircleNotch className="size-4 animate-spin" />
												) : (
													<Trash className="size-4" />
												)}
											</Button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{!loading && total > 0 ? (
				<div className="flex items-center justify-between gap-4">
					<p className="text-xs text-muted-foreground">
						{rangeStart}–{rangeEnd} of {total}
					</p>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							type="button"
							disabled={page === 0}
							onClick={() => setPage((p) => Math.max(0, p - 1))}
						>
							<CaretLeft className="size-4" />
							Previous
						</Button>
						<span className="text-xs text-muted-foreground tabular-nums">
							{page + 1} / {pageCount}
						</span>
						<Button
							variant="outline"
							size="sm"
							type="button"
							disabled={page >= pageCount - 1}
							onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
						>
							Next
							<CaretRight className="size-4" />
						</Button>
					</div>
				</div>
			) : null}

			<UploadDialog
				open={uploadOpen}
				onOpenChange={setUploadOpen}
				onUploaded={() => {
					// New docs sort to the top; jump to the first page to reveal them.
					if (page === 0) void load(0);
					else setPage(0);
				}}
			/>
		</div>
	);
}
