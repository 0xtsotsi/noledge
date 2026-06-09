"use client";

import { Brain, CircleNotch } from "@phosphor-icons/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import type { BrainGraph } from "@/lib/ai/brain/graph";

// WebGL canvas — never render on the server.
const BrainGraphCanvas = dynamic(
	() => import("./brain-graph").then((mod) => mod.BrainGraph),
	{ ssr: false },
);

export function BrainView(): React.JSX.Element {
	const [graph, setGraph] = useState<BrainGraph | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
			setError(null);
			const response = await fetch("/api/brain");
			if (!response.ok) {
				let message = `Could not load The Brain (${response.status}).`;
				try {
					const body = (await response.json()) as { error?: string };
					message = body.error ?? message;
				} catch {
					// Keep the status-based fallback.
				}
				throw new Error(message);
			}
			const data = (await response.json()) as BrainGraph;
			setGraph(data);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: "Could not load The Brain.",
			);
			setGraph(null);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (loading) {
		return (
			<div className="flex size-full items-center justify-center bg-background">
				<CircleNotch className="size-6 animate-spin text-cyan-400/70" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex size-full animate-rise-in flex-col items-center justify-center gap-2 bg-background text-center">
				<Brain className="size-8 text-destructive" />
				<p className="text-sm font-medium text-foreground">
					The Brain could not load
				</p>
				<p className="max-w-sm text-xs text-muted-foreground">{error}</p>
			</div>
		);
	}

	if (!graph || graph.nodes.length === 0) {
		return (
			<div className="flex size-full animate-rise-in flex-col items-center justify-center gap-2 bg-background text-center">
				<Brain className="size-8 text-muted-foreground" />
				<p className="text-sm font-medium text-foreground">
					The Brain is empty
				</p>
				<p className="text-xs text-muted-foreground">
					Upload docs in Knowledge and the idea-web will wake up.
				</p>
			</div>
		);
	}

	return (
		<div className="relative size-full animate-fade-in overflow-hidden">
			<div className="pointer-events-none absolute left-6 top-6 z-10 animate-rise-in">
				<h1 className="text-lg font-semibold tracking-tight text-foreground">
					The Brain
				</h1>
				<p className="text-xs text-muted-foreground">
					{graph.nodes.length}{" "}
					{graph.level === "document" ? "documents" : "idea sparks"} ·{" "}
					{graph.links.length} links · {graph.documentCount} source
					{graph.documentCount === 1 ? "" : "s"}
				</p>
			</div>
			<BrainGraphCanvas graph={graph} />
		</div>
	);
}
