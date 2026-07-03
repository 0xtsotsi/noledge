"use client";

import { Microphone, Stop } from "@phosphor-icons/react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { notifyError, notifySuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Reusable mic button. While recording, swaps to a stop icon and pulses. On
 * stop, posts the captured webm/opus blob to `/api/audio/transcribe` and calls
 * `onTranscript(text)`. The browser's MediaRecorder picks the best supported
 * codec (Chrome/Edge prefer `audio/webm; codecs=opus`, Safari prefers `mp4`).
 *
 * The recording requires HTTPS or localhost. On environments where mic access
 * is blocked (cloud preview without a domain, blocked permissions), the
 * promise resolves to `null` and we surface a toast rather than throwing.
 */
type VoiceButtonProps = {
	/** Called with the transcribed text on a successful recording. */
	onTranscript: (text: string) => void;
	/** Optional label override (defaults to "Dictate"). */
	label?: string;
	/** Extra class names applied to the outer button. */
	className?: string;
	/** Disable while the parent is busy (e.g. submitting a form). */
	disabled?: boolean;
};

export function VoiceButton({
	onTranscript,
	label = "Dictate",
	className,
	disabled,
}: VoiceButtonProps): React.JSX.Element {
	const [recording, setRecording] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);

	const start = useCallback(async () => {
		if (recording || transcribing) return;
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
				? "audio/webm;codecs=opus"
				: MediaRecorder.isTypeSupported("audio/webm")
					? "audio/webm"
					: "";
			const recorder = mimeType
				? new MediaRecorder(stream, { mimeType })
				: new MediaRecorder(stream);
			recorderRef.current = recorder;
			chunksRef.current = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunksRef.current.push(event.data);
			};
			recorder.onstop = async () => {
				stream.getTracks().forEach((track) => {
					track.stop();
				});
				setRecording(false);
				setTranscribing(true);
				try {
					const blob = new Blob(chunksRef.current, {
						type: recorder.mimeType || "audio/webm",
					});
					const response = await fetch("/api/audio/transcribe", {
						method: "POST",
						headers: { "Content-Type": blob.type || "audio/webm" },
						body: blob,
					});
					if (!response.ok) {
						const data = (await response.json().catch(() => ({}))) as {
							error?: string;
						};
						notifyError(null, data.error ?? "Transcription failed.");
						return;
					}
					const data = (await response.json()) as { text?: string };
					const text = data.text?.trim() ?? "";
					if (!text) {
						notifyError(null, "No speech detected.");
						return;
					}
					onTranscript(text);
					notifySuccess("Transcript ready.");
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					notifyError(null, `Transcription failed: ${message}`);
				} finally {
					setTranscribing(false);
					chunksRef.current = [];
				}
			};
			recorder.start();
			setRecording(true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifyError(
				null,
				`Microphone unavailable: ${message}. Voice requires HTTPS or localhost.`,
			);
		}
	}, [onTranscript, recording, transcribing]);

	const stop = useCallback(() => {
		recorderRef.current?.stop();
	}, []);

	const onClick = (): void => {
		if (recording) stop();
		else void start();
	};

	return (
		<Button
			variant={recording ? "destructive" : "ghost"}
			size="icon"
			type="button"
			aria-label={recording ? "Stop recording" : label}
			aria-pressed={recording}
			disabled={disabled || transcribing}
			onClick={onClick}
			className={cn(
				recording && "animate-pulse",
				transcribing && "opacity-60",
				className,
			)}
		>
			{recording ? (
				<Stop weight="fill" className="size-4" />
			) : (
				<Microphone className="size-5" />
			)}
		</Button>
	);
}
