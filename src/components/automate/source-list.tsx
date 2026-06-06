"use client";

import {
	CheckCircle,
	CircleNotch,
	Clock,
	Trash,
	WarningCircle,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { AutomationSourceItem } from "@/hooks/use-automation";
import { cn } from "@/lib/utils";

type SourceListProps = {
	sources: AutomationSourceItem[];
	onRemove: (id: string) => Promise<void>;
	emptyLabel: string;
};

function StatusBadge({
	source,
}: {
	source: AutomationSourceItem;
}): React.JSX.Element {
	if (source.lastStatus === "ok") {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
				<CheckCircle className="size-3.5" /> OK
			</span>
		);
	}
	if (source.lastStatus === "partial") {
		return (
			<span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
				<WarningCircle className="size-3.5" /> Partial
			</span>
		);
	}
	if (source.lastStatus === "error") {
		return (
			<span
				className="inline-flex items-center gap-1 text-xs text-destructive"
				title={source.lastError ?? undefined}
			>
				<WarningCircle className="size-3.5" /> Error
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
			<Clock className="size-3.5" /> Not polled
		</span>
	);
}

export function SourceList({
	sources,
	onRemove,
	emptyLabel,
}: SourceListProps): React.JSX.Element {
	const [removing, setRemoving] = useState<string | null>(null);

	if (sources.length === 0) {
		return (
			<p className="animate-fade-in py-6 text-center text-xs text-muted-foreground">
				{emptyLabel}
			</p>
		);
	}

	const remove = async (id: string): Promise<void> => {
		setRemoving(id);
		try {
			await onRemove(id);
		} finally {
			setRemoving(null);
		}
	};

	return (
		<ul className="flex flex-col divide-y overflow-hidden rounded-lg border">
			<AnimatePresence initial={false}>
				{sources.map((source) => (
					<motion.li
						key={source.id}
						layout
						initial={{ opacity: 0, height: 0 }}
						animate={{ opacity: 1, height: "auto" }}
						exit={{ opacity: 0, height: 0 }}
						transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
						className="flex items-center gap-3 px-3 py-2.5 text-sm"
					>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium">
								{source.title ?? source.url}
							</p>
							<p className="truncate text-xs text-muted-foreground">
								{source.url}
							</p>
						</div>
						<StatusBadge source={source} />
						<button
							type="button"
							onClick={() => void remove(source.id)}
							disabled={removing === source.id}
							aria-label={`Remove ${source.title ?? source.url}`}
							className={cn(
								"rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
								"disabled:pointer-events-none disabled:opacity-50",
							)}
						>
							{removing === source.id ? (
								<CircleNotch className="size-4 animate-spin" />
							) : (
								<Trash className="size-4" />
							)}
						</button>
					</motion.li>
				))}
			</AnimatePresence>
		</ul>
	);
}
