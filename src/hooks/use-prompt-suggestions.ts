"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "noledge-prompt-suggestions";
const CHANGE_EVENT = "prompt-suggestions:changed";

export const DEFAULT_PROMPT_SUGGESTIONS = [
	"What new information is in my brain from today?",
	"Summarize the most important information from the last 7 days.",
] as const;

function normalizeSuggestions(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0 || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized.length > 0 ? normalized : [...DEFAULT_PROMPT_SUGGESTIONS];
}

function readSuggestions(): string[] {
	if (typeof window === "undefined") return [...DEFAULT_PROMPT_SUGGESTIONS];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return [...DEFAULT_PROMPT_SUGGESTIONS];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [...DEFAULT_PROMPT_SUGGESTIONS];
		return normalizeSuggestions(
			parsed.filter((item): item is string => typeof item === "string"),
		);
	} catch {
		return [...DEFAULT_PROMPT_SUGGESTIONS];
	}
}

function writeSuggestions(values: readonly string[]): string[] {
	const normalized = normalizeSuggestions(values);
	if (typeof window === "undefined") return normalized;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
		window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
	} catch {
		/* ignore storage errors */
	}
	return normalized;
}

export function usePromptSuggestions(): {
	suggestions: string[];
	setSuggestions: (values: readonly string[]) => void;
	resetSuggestions: () => void;
} {
	const [suggestions, setSuggestionState] = useState<string[]>(readSuggestions);

	useEffect(() => {
		const sync = (): void => setSuggestionState(readSuggestions());
		window.addEventListener("storage", sync);
		window.addEventListener(CHANGE_EVENT, sync);
		return () => {
			window.removeEventListener("storage", sync);
			window.removeEventListener(CHANGE_EVENT, sync);
		};
	}, []);

	const setSuggestions = useCallback((values: readonly string[]): void => {
		setSuggestionState(writeSuggestions(values));
	}, []);

	const resetSuggestions = useCallback((): void => {
		setSuggestionState(writeSuggestions(DEFAULT_PROMPT_SUGGESTIONS));
	}, []);

	return { suggestions, setSuggestions, resetSuggestions };
}
