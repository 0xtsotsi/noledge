import { type ChatMessage, streamMockResponse } from "@/lib/chat-mock";

type ChatRequestBody = {
	messages?: ChatMessage[];
};

function isChatMessage(value: unknown): value is ChatMessage {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.id === "string" &&
		(candidate.role === "user" ||
			candidate.role === "assistant" ||
			candidate.role === "system") &&
		Array.isArray(candidate.parts)
	);
}

export async function POST(request: Request): Promise<Response> {
	let body: ChatRequestBody;
	try {
		body = (await request.json()) as ChatRequestBody;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const messages = Array.isArray(body.messages)
		? body.messages.filter(isChatMessage)
		: [];

	if (messages.length === 0) {
		return Response.json(
			{ error: "`messages` must be a non-empty array" },
			{ status: 400 },
		);
	}

	const stream = streamMockResponse(messages, request.signal);

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
