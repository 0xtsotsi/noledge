"use client";

import { Gear } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ChatContainerContent,
	ChatContainerRoot,
} from "@/components/prompt-kit/chat-container";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import { Button } from "@/components/ui/button";
import { usePromptSuggestions } from "@/hooks/use-prompt-suggestions";
import type {
	ChatMessage as ApiMessage,
	ChatStreamChunk,
} from "@/lib/ai/chat/sse";
import { notifyError } from "@/lib/toast";
import { ChatInputBar } from "./chat-input-bar";
import { ChatMessage } from "./chat-message";
import type { Attachment, ChatStatus, UiMessage } from "./types";

function createId(): string {
	return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Largest single attachment accepted client-side (mirrors the server cap). */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function toApiMessages(messages: UiMessage[]): ApiMessage[] {
	return messages.map((message) => ({
		id: message.id,
		role: message.role,
		parts: [
			{ type: "text" as const, text: message.content },
			...(message.attachments ?? []).map((attachment) => ({
				type: "file" as const,
				name: attachment.name,
				mediaType: attachment.type || "application/octet-stream",
				data: attachment.data,
			})),
		],
	}));
}

/** Read a file's bytes as a base64 string (without the `data:` URL prefix). */
function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== "string") {
				reject(new Error("Unexpected file reader result"));
				return;
			}
			const comma = result.indexOf(",");
			resolve(comma === -1 ? result : result.slice(comma + 1));
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("File read failed"));
		reader.readAsDataURL(file);
	});
}

function makeTitle(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= 60) return trimmed;
	return `${trimmed.slice(0, 57)}…`;
}

type Conversation = {
	id: string;
	title: string;
	messages: {
		role: "user" | "assistant";
		content: string;
		reasoning?: string;
		sources?: UiMessage["sources"];
		steps?: UiMessage["steps"];
	}[];
};

export function Chat(): React.JSX.Element {
	const searchParams = useSearchParams();
	const chatIdFromUrl = searchParams.get("chat");
	const router = useRouter();

	const [messages, setMessages] = useState<UiMessage[]>([]);
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<ChatStatus>("ready");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const { suggestions } = usePromptSuggestions();
	const [model, setModel] = useState<string | null>(() => {
		if (typeof window === "undefined") return null;
		try {
			return window.localStorage.getItem("noledge-model");
		} catch {
			return null;
		}
	});
	const [hasModels, setHasModels] = useState<boolean | null>(null);
	const [reasoningModelIds, setReasoningModelIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [thinking, setThinking] = useState<boolean>(() => {
		if (typeof window === "undefined") return true;
		try {
			return window.localStorage.getItem("noledge-thinking") !== "off";
		} catch {
			return true;
		}
	});
	const [webSearch, setWebSearch] = useState<boolean>(() => {
		if (typeof window === "undefined") return false;
		try {
			return window.localStorage.getItem("noledge-web-search") === "on";
		} catch {
			return false;
		}
	});
	const webSearchRef = useRef<boolean>(webSearch);
	webSearchRef.current = webSearch;
	const [loadingConversation, setLoadingConversation] = useState(
		Boolean(chatIdFromUrl),
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	const abortRef = useRef<AbortController | null>(null);
	// The stream that currently "owns" this view. A stream started in one
	// conversation keeps running (and saving) in the background after you
	// navigate away, but it must not touch the view it no longer owns.
	const currentStreamRef = useRef<AbortController | null>(null);
	const mountedRef = useRef(true);
	const modelRef = useRef<string | null>(null);
	modelRef.current = model;
	const thinkingRef = useRef<boolean>(thinking);
	thinkingRef.current = thinking;

	const conversationIdRef = useRef<string | null>(null);
	const loadedChatIdRef = useRef<string | null>(null);
	// Bumped on every load so a slow/stale fetch can't clobber a newer one.
	const loadTokenRef = useRef(0);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// Persist model selection
	useEffect(() => {
		if (model) {
			try {
				window.localStorage.setItem("noledge-model", model);
			} catch {
				/* ignore storage errors */
			}
		}
	}, [model]);

	// Persist thinking toggle
	useEffect(() => {
		try {
			window.localStorage.setItem("noledge-thinking", thinking ? "on" : "off");
		} catch {
			/* ignore storage errors */
		}
	}, [thinking]);

	// Persist web search toggle
	useEffect(() => {
		try {
			window.localStorage.setItem(
				"noledge-web-search",
				webSearch ? "on" : "off",
			);
		} catch {
			/* ignore storage errors */
		}
	}, [webSearch]);

	// Load conversation from URL
	useEffect(() => {
		const token = ++loadTokenRef.current;
		if (!chatIdFromUrl) {
			// Fresh "New chat" screen: detach any background stream from this view
			// (it keeps running and still saves) and reset to an empty composer.
			currentStreamRef.current = null;
			setStatus("ready");
			setMessages([]);
			conversationIdRef.current = null;
			loadedChatIdRef.current = null;
			setLoadingConversation(false);
			setLoadError(null);
			return;
		}
		if (loadedChatIdRef.current === chatIdFromUrl) {
			// Already showing this conversation (e.g. we just adopted a freshly
			// created id after streaming) — don't reload or disturb the stream.
			setLoadingConversation(false);
			return;
		}
		// Switching to a different existing conversation: detach the in-flight
		// stream so its completion can't flip this view's state.
		currentStreamRef.current = null;
		setStatus("ready");
		setLoadingConversation(true);
		setLoadError(null);
		fetch(`/api/conversations/${chatIdFromUrl}`)
			.then((res) => {
				if (!res.ok) throw new Error("Failed to load conversation");
				return res.json() as Promise<{ conversation: Conversation }>;
			})
			.then((data) => {
				if (loadTokenRef.current !== token) return; // a newer load won
				const loaded = data.conversation.messages.map((m, i) => ({
					id: `m-${chatIdFromUrl}-${i}`,
					role: m.role,
					content: m.content,
					...(m.reasoning ? { reasoning: m.reasoning } : {}),
					...(m.sources ? { sources: m.sources } : {}),
					...(m.steps ? { steps: m.steps } : {}),
				}));
				setMessages(loaded);
				conversationIdRef.current = data.conversation.id;
				loadedChatIdRef.current = chatIdFromUrl;
			})
			.catch(() => {
				if (loadTokenRef.current !== token) return;
				setLoadError("Could not load this conversation.");
			})
			.finally(() => {
				if (loadTokenRef.current !== token) return;
				setLoadingConversation(false);
			});
	}, [chatIdFromUrl]);

	useEffect(() => {
		let active = true;
		fetch("/api/models")
			.then((res) => res.json())
			.then((data: { models: { id: string; reasoning?: boolean }[] }) => {
				if (!active) return;
				setHasModels(data.models.length > 0);
				setReasoningModelIds(
					new Set(data.models.filter((m) => m.reasoning).map((m) => m.id)),
				);
			})
			.catch(() => {
				if (active) setHasModels(false);
			});
		return () => {
			active = false;
		};
	}, []);

	const updateAssistant = useCallback(
		(id: string, patch: (prev: UiMessage) => UiMessage): void => {
			setMessages((prev) =>
				prev.map((message) => (message.id === id ? patch(message) : message)),
			);
		},
		[],
	);

	const runStream = useCallback(
		async (
			history: UiMessage[],
			options: { appendUser?: boolean } = {},
		): Promise<void> => {
			const assistantId = createId();
			setMessages((prev) => [
				...prev,
				{ id: assistantId, role: "assistant", content: "" },
			]);
			setStatus("submitting");

			const controller = new AbortController();
			abortRef.current = controller;
			currentStreamRef.current = controller;

			// True only while this stream still owns the visible view. Once the user
			// navigates elsewhere the stream keeps running in the background (so it
			// still saves) but stops mutating the view it no longer owns.
			const isCurrent = (): boolean => currentStreamRef.current === controller;

			// Adopt a conversation id into the live view (and rewrite the URL), but
			// only while this stream still owns the visible, mounted view — never
			// yank the user back from another chat/page.
			const adopt = (id: string): void => {
				if (isCurrent() && mountedRef.current) {
					conversationIdRef.current = id;
					loadedChatIdRef.current = id;
					router.replace(`/?chat=${id}`);
				}
			};

			// The server creates the conversation (and persists the user turn)
			// before streaming; for a brand-new chat we adopt its id from the
			// first `conversation` chunk below.
			let convId = conversationIdRef.current;
			if (convId) {
				window.dispatchEvent(
					new CustomEvent("conversation:stream", {
						detail: { id: convId, streaming: true },
					}),
				);
			}

			// Throttle text rendering: tokens arrive far faster than the UI needs to
			// repaint. We buffer deltas and flush the accumulated text on a ~50ms
			// cadence so React re-renders (and the markdown re-lex) stay bounded
			// regardless of token rate.
			let assistantContent = "";
			let pendingText = "";
			let flushTimer: ReturnType<typeof setTimeout> | null = null;
			let sawError = false;

			// Surface a stream/transport failure on the assistant turn and park the
			// composer in the "error" state until the next send/regenerate.
			const surfaceError = (message: string): void => {
				sawError = true;
				if (!isCurrent()) return;
				updateAssistant(assistantId, (prev) => ({ ...prev, error: message }));
				setStatus("error");
			};

			const flushText = (): void => {
				flushTimer = null;
				if (!pendingText) return;
				const delta = pendingText;
				pendingText = "";
				if (!isCurrent()) return;
				updateAssistant(assistantId, (prev) => ({
					...prev,
					content: prev.content + delta,
				}));
			};

			const scheduleFlush = (): void => {
				if (flushTimer === null) flushTimer = setTimeout(flushText, 50);
			};

			try {
				const response = await fetch("/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						messages: toApiMessages(history),
						conversationId: convId ?? undefined,
						title: convId
							? undefined
							: makeTitle(
									history.find((m) => m.role === "user")?.content ?? "",
								) || undefined,
						appendUser: options.appendUser ?? true,
						model: modelRef.current ?? undefined,
						thinking: thinkingRef.current,
						webSearch: webSearchRef.current,
						timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					let message = "Something went wrong while generating a response.";
					try {
						const data = (await response.json()) as { error?: unknown };
						if (typeof data.error === "string" && data.error) {
							message = data.error;
						}
					} catch {
						/* non-JSON error body — keep the generic message */
					}
					surfaceError(message);
				} else {
					if (!response.body) throw new Error("No response body");

					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });

						const events = buffer.split("\n\n");
						buffer = events.pop() ?? "";

						for (const event of events) {
							const line = event.trim();
							if (!line.startsWith("data:")) continue;
							const json = line.slice(5).trim();
							if (!json) continue;
							const chunk = JSON.parse(json) as ChatStreamChunk;

							if (chunk.type === "text") {
								assistantContent += chunk.text;
								if (isCurrent()) setStatus("streaming");
								pendingText += chunk.text;
								scheduleFlush();
							} else if (chunk.type === "reasoning") {
								if (isCurrent()) {
									setStatus("streaming");
									updateAssistant(assistantId, (prev) => ({
										...prev,
										reasoning: (prev.reasoning ?? "") + chunk.text,
									}));
								}
							} else if (chunk.type === "step") {
								if (isCurrent())
									updateAssistant(assistantId, (prev) => ({
										...prev,
										steps: [...(prev.steps ?? []), chunk.step],
									}));
							} else if (chunk.type === "source") {
								if (isCurrent())
									updateAssistant(assistantId, (prev) => ({
										...prev,
										sources: [...(prev.sources ?? []), chunk.source],
									}));
							} else if (chunk.type === "conversation") {
								if (!convId) {
									convId = chunk.id;
									adopt(chunk.id);
									window.dispatchEvent(
										new CustomEvent("conversations:changed"),
									);
									window.dispatchEvent(
										new CustomEvent("conversation:stream", {
											detail: { id: chunk.id, streaming: true },
										}),
									);
								}
							} else if (chunk.type === "error") {
								surfaceError(chunk.message);
							}
						}
					}
					// Flush any buffered tail so no trailing tokens are dropped.
					if (flushTimer !== null) clearTimeout(flushTimer);
					flushText();
				}
			} catch (error) {
				if (flushTimer !== null) clearTimeout(flushTimer);
				flushText();
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					surfaceError("Something went wrong while generating a response.");
				}
			} finally {
				if (abortRef.current === controller) abortRef.current = null;
				if (isCurrent()) {
					currentStreamRef.current = null;
					if (!sawError) setStatus("ready");
				}
			}

			// Tell the sidebar this stream is no longer running so it can stop the
			// shimmer. `done` flags a real completion (vs. an empty abort) so the
			// sidebar can mark unopened sessions as freshly finished.
			const stoppedEmpty = controller.signal.aborted && !assistantContent;
			const emitStreamEnd = (id: string): void => {
				window.dispatchEvent(
					new CustomEvent("conversation:stream", {
						detail: { id, streaming: false, done: !stoppedEmpty },
					}),
				);
			};

			// Persistence happened server-side as the stream ran; just refresh the
			// sidebar ordering and stop the shimmer.
			if (!stoppedEmpty) {
				window.dispatchEvent(new CustomEvent("conversations:changed"));
			}
			if (convId) emitStreamEnd(convId);
		},
		[router, updateAssistant],
	);

	const sendMessage = useCallback((): void => {
		const text = input.trim();
		const canSend = status === "ready" || status === "error";
		if ((text.length === 0 && attachments.length === 0) || !canSend) {
			return;
		}

		const userMessage: UiMessage = {
			id: createId(),
			role: "user",
			content: text,
			attachments: attachments.length > 0 ? attachments : undefined,
		};

		const history = [...messages, userMessage];
		setMessages(history);
		setInput("");
		setAttachments([]);
		void runStream(history);
	}, [attachments, input, messages, runStream, status]);

	const stop = useCallback((): void => {
		abortRef.current?.abort();
	}, []);

	const regenerate = useCallback((): void => {
		if (status !== "ready" && status !== "error") return;
		let lastUserIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				lastUserIndex = i;
				break;
			}
		}
		if (lastUserIndex === -1) return;
		const history = messages.slice(0, lastUserIndex + 1);
		setMessages(history);
		void runStream(history, { appendUser: false });
	}, [messages, runStream, status]);

	const onFilesAdded = useCallback((files: File[]): void => {
		for (const file of files) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				notifyError(
					null,
					`"${file.name}" is too large (max ${Math.floor(
						MAX_ATTACHMENT_BYTES / (1024 * 1024),
					)} MB).`,
				);
				continue;
			}
			const id = createId();
			const url = URL.createObjectURL(file);
			readFileAsBase64(file)
				.then((data) => {
					setAttachments((prev) => [
						...prev,
						{ id, name: file.name, type: file.type, url, data },
					]);
				})
				.catch(() => {
					URL.revokeObjectURL(url);
					notifyError(null, `Could not read "${file.name}".`);
				});
		}
	}, []);

	const removeAttachment = useCallback((id: string): void => {
		setAttachments((prev) => {
			const target = prev.find((attachment) => attachment.id === id);
			if (target) URL.revokeObjectURL(target.url);
			return prev.filter((attachment) => attachment.id !== id);
		});
	}, []);

	if (loadingConversation) {
		return (
			<div className="flex h-full items-center justify-center">
				<p className="text-sm text-muted-foreground">Loading conversation…</p>
			</div>
		);
	}

	if (loadError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4">
				<p className="text-sm text-muted-foreground">{loadError}</p>
				<Button variant="outline" size="sm" asChild>
					<a href="/">Start a new chat</a>
				</Button>
			</div>
		);
	}

	const thinkingSupported = model ? reasoningModelIds.has(model) : false;
	// Only Anthropic Claude and OpenAI gpt-/o3/o4 models have a web-search tool
	// wired in `app/api/chat/route.ts`. Mirror the same gate here so the button
	// shows as enabled and not stuck-on for unsupported models.
	const id = model?.toLowerCase() ?? "";
	const webSearchSupported =
		id.startsWith("claude-") ||
		id.startsWith("gpt-") ||
		id.startsWith("o3") ||
		id.startsWith("o4");
	const isEmpty = messages.length === 0;

	if (isEmpty) {
		const noProviders = hasModels === false;
		return (
			<div className="flex h-full flex-col items-center justify-center px-4">
				<div className="w-full max-w-2xl animate-rise-in space-y-6">
					{noProviders ? (
						<div className="flex flex-col items-center gap-4 text-center">
							<h1 className="text-2xl font-semibold tracking-tight">
								No providers connected
							</h1>
							<p className="text-sm text-muted-foreground">
								Add an API key in Settings to start chatting.
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									document
										.querySelector<HTMLButtonElement>("[data-settings-trigger]")
										?.click();
								}}
							>
								<Gear className="size-4" />
								Open Settings
							</Button>
						</div>
					) : (
						<>
							<h1 className="text-center text-3xl font-semibold tracking-tight">
								Ask your brain anything
							</h1>
							<ChatInputBar
								value={input}
								onValueChange={setInput}
								onSubmit={sendMessage}
								onStop={stop}
								status={status}
								attachments={attachments}
								onFilesAdded={onFilesAdded}
								onRemoveAttachment={removeAttachment}
								model={model}
								onModelChange={setModel}
								thinking={thinking}
								onThinkingChange={setThinking}
								thinkingSupported={thinkingSupported}
								webSearch={webSearch}
								onWebSearchChange={setWebSearch}
								webSearchSupported={webSearchSupported}
								suggestions={suggestions}
							/>
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<ChatContainerRoot className="relative flex-1">
				<ChatContainerContent className="mx-auto w-full max-w-3xl gap-8 px-4 py-8">
					{messages.map((message, index) => (
						<ChatMessage
							key={message.id}
							message={message}
							isLast={index === messages.length - 1}
							status={status}
							onRegenerate={regenerate}
						/>
					))}
				</ChatContainerContent>
				<div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
					<div className="pointer-events-auto">
						<ScrollButton />
					</div>
				</div>
			</ChatContainerRoot>

			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				<ChatInputBar
					value={input}
					onValueChange={setInput}
					onSubmit={sendMessage}
					onStop={stop}
					status={status}
					attachments={attachments}
					onFilesAdded={onFilesAdded}
					onRemoveAttachment={removeAttachment}
					model={model}
					onModelChange={setModel}
					thinking={thinking}
					onThinkingChange={setThinking}
					thinkingSupported={thinkingSupported}
					webSearch={webSearch}
					onWebSearchChange={setWebSearch}
					webSearchSupported={webSearchSupported}
					suggestions={suggestions}
				/>
			</div>
		</div>
	);
}
