import { toast } from "sonner";

/**
 * Turn anything thrown or returned into a short, human-readable message.
 * Never surfaces raw JSON blobs or stack traces to the user.
 */
export function toMessage(error: unknown, fallback: string): string {
	if (typeof error === "string") {
		const trimmed = error.trim();
		if (trimmed.length > 0 && !looksLikeJson(trimmed)) return trimmed;
		return fallback;
	}
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message.length > 0 && !looksLikeJson(message)) return message;
	}
	return fallback;
}

function looksLikeJson(value: string): boolean {
	return (
		(value.startsWith("{") && value.endsWith("}")) ||
		(value.startsWith("[") && value.endsWith("]"))
	);
}

/** Show a short error toast (bottom-right). */
export function notifyError(error: unknown, fallback: string): void {
	toast.error(toMessage(error, fallback));
}

/** Show a short success toast (bottom-right). */
export function notifySuccess(message: string): void {
	toast.success(message);
}

export { toast };
