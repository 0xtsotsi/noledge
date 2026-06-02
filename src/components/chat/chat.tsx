"use client";

import { useCallback, useRef, useState } from "react";

import {
	ChatContainerContent,
	ChatContainerRoot,
} from "@/components/prompt-kit/chat-container";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import type {
	ChatMessage as ApiMessage,
	ChatStreamChunk,
} from "@/lib/chat-mock";
import { ChatInputBar } from "./chat-input-bar";
import { ChatMessage } from "./chat-message";
import type { Attachment, ChatStatus, UiMessage } from "./types";

function createId(): string {
	return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toApiMessages(messages: UiMessage[]): ApiMessage[] {
	return messages.map((message) => ({
		id: message.id,
		role: message.role,
		parts: [{ type: "text", text: message.content }],
	}));
}

export function Chat(): React.JSX.Element {
	const [messages, setMessages] = useState<UiMessage[]>([]);
	const [input, setInput] = useState("");
	const [status, setStatus] = useState<ChatStatus>("ready");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const abortRef = useRef<AbortController | null>(null);

	const updateAssistant = useCallback(
		(id: string, patch: (prev: UiMessage) => UiMessage): void => {
			setMessages((prev) =>
				prev.map((message) => (message.id === id ? patch(message) : message)),
			);
		},
		[],
	);

	const runStream = useCallback(
		async (history: UiMessage[]): Promise<void> => {
			const assistantId = createId();
			setMessages((prev) => [
				...prev,
				{ id: assistantId, role: "assistant", content: "" },
			]);
			setStatus("submitting");

			const controller = new AbortController();
			abortRef.current = controller;

			try {
				const response = await fetch("/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ messages: toApiMessages(history) }),
					signal: controller.signal,
				});

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
							setStatus("streaming");
							updateAssistant(assistantId, (prev) => ({
								...prev,
								content: prev.content + chunk.text,
							}));
						} else if (chunk.type === "reasoning") {
							updateAssistant(assistantId, (prev) => ({
								...prev,
								reasoning: chunk.text,
							}));
						} else if (chunk.type === "step") {
							updateAssistant(assistantId, (prev) => ({
								...prev,
								steps: [...(prev.steps ?? []), chunk.step],
							}));
						} else if (chunk.type === "source") {
							updateAssistant(assistantId, (prev) => ({
								...prev,
								sources: [...(prev.sources ?? []), chunk.source],
							}));
						} else if (chunk.type === "image") {
							updateAssistant(assistantId, (prev) => ({
								...prev,
								image: { url: chunk.url, alt: chunk.alt },
							}));
						}
					}
				}
			} catch (error) {
				if (!(error instanceof DOMException && error.name === "AbortError")) {
					updateAssistant(assistantId, (prev) => ({
						...prev,
						content:
							prev.content ||
							"Something went wrong while generating a response.",
					}));
				}
			} finally {
				abortRef.current = null;
				setStatus("ready");
			}
		},
		[updateAssistant],
	);

	const sendMessage = useCallback((): void => {
		const text = input.trim();
		if ((text.length === 0 && attachments.length === 0) || status !== "ready") {
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
		if (status !== "ready") return;
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
		void runStream(history);
	}, [messages, runStream, status]);

	const onFilesAdded = useCallback((files: File[]): void => {
		const next = files.map((file) => ({
			id: createId(),
			name: file.name,
			type: file.type,
			url: URL.createObjectURL(file),
		}));
		setAttachments((prev) => [...prev, ...next]);
	}, []);

	const removeAttachment = useCallback((id: string): void => {
		setAttachments((prev) => {
			const target = prev.find((attachment) => attachment.id === id);
			if (target) URL.revokeObjectURL(target.url);
			return prev.filter((attachment) => attachment.id !== id);
		});
	}, []);

	const isEmpty = messages.length === 0;

	if (isEmpty) {
		return (
			<div className="flex h-full flex-col items-center justify-center px-4">
				<div className="w-full max-w-2xl space-y-6">
					<h1 className="text-center text-3xl font-semibold tracking-tight">
						What can I help with?
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
					/>
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
				/>
				<p className="mt-2 text-center text-xs text-muted-foreground">
					Mock responses — swap{" "}
					<code className="font-mono">src/lib/chat-mock.ts</code> for a real
					provider.
				</p>
			</div>
		</div>
	);
}
