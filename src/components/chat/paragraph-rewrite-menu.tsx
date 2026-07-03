"use client";

import { MagicWand, PencilSimple, X } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/toast";

/**
 * Floating rewrite menu that appears when the user hovers over a paragraph in
 * an assistant message. For v1 the menu operates on the WHOLE assistant
 * message (a single-paragraph answer is the common case) — the underlying
 * `/api/chat/rewrite-paragraph` route supports per-paragraph via
 * `paragraphIndex`, and v2 of this component will split the message at
 * `\n\n` boundaries before rendering.
 *
 * The menu offers two actions:
 *   - **Edit**: opens an inline textarea; on save, calls `onReplace(text)`.
 *   - **Rewrite**: sends the paragraph to `gpt-4o-mini` with the user's
 *     instruction; streams back the rewrite via `onReplace` when done.
 */
type ParagraphRewriteMenuProps = {
	paragraph: string;
	conversationId: string | null;
	messageId: string;
	paragraphIndex: number;
	onReplace: (text: string) => void;
};

export function ParagraphRewriteMenu({
	paragraph,
	conversationId,
	messageId,
	paragraphIndex,
	onReplace,
}: ParagraphRewriteMenuProps): React.JSX.Element {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(paragraph);
	const [instruction, setInstruction] = useState("");
	const [rewriting, setRewriting] = useState(false);

	const startEdit = useCallback(() => {
		setDraft(paragraph);
		setEditing(true);
	}, [paragraph]);

	const save = useCallback(() => {
		onReplace(draft);
		setEditing(false);
	}, [draft, onReplace]);

	const rewrite = useCallback(async () => {
		if (!conversationId || instruction.trim().length === 0) return;
		setRewriting(true);
		try {
			const response = await fetch("/api/chat/rewrite-paragraph", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					conversationId,
					messageId,
					paragraphIndex,
					instruction: instruction.trim(),
				}),
			});
			if (!response.ok) {
				const data = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				notifyError(null, data.error ?? "Rewrite failed.");
				return;
			}
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let assembled = "";
			if (!reader) {
				notifyError(null, "No response body.");
				return;
			}
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
					const parsed = JSON.parse(json) as
						| { type: "delta"; text: string }
						| { type: "done"; paragraph: string }
						| { type: "error"; message: string };
					if (parsed.type === "delta") assembled += parsed.text;
					else if (parsed.type === "done") {
						onReplace(parsed.paragraph || assembled);
						setInstruction("");
						setRewriting(false);
						return;
					} else if (parsed.type === "error") {
						notifyError(null, parsed.message);
						setRewriting(false);
						return;
					}
				}
			}
			if (assembled) onReplace(assembled);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifyError(null, message);
		} finally {
			setRewriting(false);
		}
	}, [conversationId, instruction, messageId, onReplace, paragraphIndex]);

	if (editing) {
		return (
			<div className="flex flex-col gap-2 rounded-lg border bg-background p-3">
				<textarea
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					className="min-h-24 w-full resize-y rounded-md border bg-transparent p-2 text-sm"
					aria-label="Edit paragraph"
				/>
				<div className="flex justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						type="button"
						onClick={() => setEditing(false)}
					>
						<X className="size-3" />
						Cancel
					</Button>
					<Button size="sm" type="button" onClick={save}>
						Save
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2 rounded-lg border bg-background/80 p-2 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
			<div className="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					type="button"
					onClick={startEdit}
					title="Edit inline"
				>
					<PencilSimple className="size-3" />
					Edit
				</Button>
				<MagicWand className="size-3" />
				<input
					type="text"
					value={instruction}
					onChange={(event) => setInstruction(event.target.value)}
					placeholder="make it more concise"
					className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs"
					aria-label="Rewrite instruction"
				/>
				<Button
					size="sm"
					type="button"
					onClick={() => void rewrite()}
					disabled={rewriting || !instruction.trim() || !conversationId}
				>
					{rewriting ? "Rewriting…" : "Rewrite"}
				</Button>
			</div>
		</div>
	);
}
