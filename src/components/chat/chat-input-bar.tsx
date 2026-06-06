"use client";

import {
	ArrowUp,
	FileText,
	Globe,
	Paperclip,
	Square,
	X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";

import {
	FileUpload,
	FileUploadTrigger,
} from "@/components/prompt-kit/file-upload";
import {
	PromptInput,
	PromptInputAction,
	PromptInputActions,
	PromptInputTextarea,
} from "@/components/prompt-kit/prompt-input";
import { PromptSuggestion } from "@/components/prompt-kit/prompt-suggestion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ModelPicker } from "./model-picker";
import type { Attachment, ChatStatus } from "./types";

export const UPLOAD_ACCEPT =
	".txt,.md,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.rtf,.csv,.html,image/*";

type ChatInputBarProps = {
	value: string;
	onValueChange: (value: string) => void;
	onSubmit: () => void;
	onStop: () => void;
	status: ChatStatus;
	attachments: Attachment[];
	onFilesAdded: (files: File[]) => void;
	onRemoveAttachment: (id: string) => void;
	model: string | null;
	onModelChange: (id: string) => void;
	thinking: boolean;
	onThinkingChange: (value: boolean) => void;
	/** Whether the selected model supports a reasoning trace. */
	thinkingSupported: boolean;
	suggestions: string[];
};

export function ChatInputBar({
	value,
	onValueChange,
	onSubmit,
	onStop,
	status,
	attachments,
	onFilesAdded,
	onRemoveAttachment,
	model,
	onModelChange,
	thinking,
	onThinkingChange,
	thinkingSupported,
	suggestions,
}: ChatInputBarProps): React.JSX.Element {
	const isBusy = status === "submitting" || status === "streaming";
	const canSend = value.trim().length > 0 || attachments.length > 0;

	return (
		<FileUpload onFilesAdded={onFilesAdded} accept={UPLOAD_ACCEPT}>
			{suggestions.length > 0 ? (
				<div className="mb-3 flex flex-wrap justify-center gap-2">
					{suggestions.map((suggestion, index) => (
						<PromptSuggestion
							key={suggestion}
							type="button"
							size="sm"
							className="h-auto max-w-full animate-rise-in px-2.5 py-1.5 text-left text-[11px] sm:text-xs"
							style={{ animationDelay: `${Math.min(index * 50, 300)}ms` }}
							onClick={() => onValueChange(suggestion)}
						>
							{suggestion}
						</PromptSuggestion>
					))}
				</div>
			) : null}
			<PromptInput
				value={value}
				onValueChange={onValueChange}
				onSubmit={onSubmit}
				isLoading={isBusy}
				className="w-full"
			>
				{attachments.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-2 pt-1 pb-2">
						<AnimatePresence initial={false}>
							{attachments.map((attachment) => (
								<motion.div
									key={attachment.id}
									layout
									initial={{ opacity: 0, scale: 0.85 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.85 }}
									transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
									className="group relative flex items-center gap-2 rounded-lg border bg-secondary py-1.5 pr-7 pl-2 text-sm"
								>
									{attachment.type.startsWith("image/") ? (
										// biome-ignore lint/performance/noImgElement: local object URL preview
										<img
											src={attachment.url}
											alt={attachment.name}
											className="size-8 rounded object-cover"
										/>
									) : (
										<FileText className="size-4 shrink-0" />
									)}
									<span className="max-w-32 truncate">{attachment.name}</span>
									<button
										type="button"
										onClick={() => onRemoveAttachment(attachment.id)}
										className="absolute top-1 right-1 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
										aria-label={`Remove ${attachment.name}`}
									>
										<X className="size-3.5" />
									</button>
								</motion.div>
							))}
						</AnimatePresence>
					</div>
				) : null}

				<PromptInputTextarea placeholder="Ask anything" />

				<PromptInputActions className="justify-between pt-2">
					<div className="flex items-center gap-2">
						<FileUploadTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								type="button"
								aria-label="Attach files"
							>
								<Paperclip className="size-5" />
							</Button>
						</FileUploadTrigger>
						<PromptInputAction tooltip="Search the web">
							<Button
								variant="ghost"
								size="sm"
								type="button"
								className="gap-1.5"
							>
								<Globe className="size-4" />
								<span>Search</span>
							</Button>
						</PromptInputAction>
						<ModelPicker value={model} onChange={onModelChange} />
						{thinkingSupported ? (
							<PromptInputAction
								tooltip={thinking ? "Thinking on" : "Thinking off"}
							>
								<Button
									variant="ghost"
									size="sm"
									type="button"
									aria-pressed={thinking}
									onClick={() => onThinkingChange(!thinking)}
									className={cn(
										"gap-1.5",
										thinking &&
											"bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
									)}
								>
									<span>Thinking</span>
								</Button>
							</PromptInputAction>
						) : null}
					</div>

					<PromptInputAction tooltip={isBusy ? "Stop" : "Send"}>
						{isBusy ? (
							<Button
								size="icon"
								className="rounded-full"
								onClick={onStop}
								type="button"
								aria-label="Stop"
							>
								<Square weight="fill" className="size-4" />
							</Button>
						) : (
							<Button
								size="icon"
								className="rounded-full"
								onClick={onSubmit}
								disabled={!canSend}
								type="button"
								aria-label="Send"
							>
								<ArrowUp className="size-5" />
							</Button>
						)}
					</PromptInputAction>
				</PromptInputActions>
			</PromptInput>
		</FileUpload>
	);
}
