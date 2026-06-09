import { z } from "zod";
import type { ChatReasoningStep, ChatSource } from "@/lib/ai/chat/sse";
import { getDatabase } from "@/lib/ai/db/client";

type ConversationRow = {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
};

type MessageRow = {
	role: string;
	content: string;
	ordinal: number;
	payload: string | null;
};

type MessagePayload = {
	reasoning?: string;
	sources?: ChatSource[];
	steps?: ChatReasoningStep[];
};

/** Parse a persisted assistant payload, tolerating NULL/corrupt JSON. */
function parsePayload(raw: string | null): MessagePayload {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as MessagePayload;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await params;
	const db = getDatabase();

	const conversation = db
		.prepare(
			"SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?",
		)
		.get(id) as ConversationRow | undefined;

	if (!conversation) {
		return Response.json({ error: "Conversation not found" }, { status: 404 });
	}

	const messages = db
		.prepare(
			"SELECT role, content, ordinal, payload FROM conversation_messages WHERE conversation_id = ? ORDER BY ordinal ASC",
		)
		.all(id) as MessageRow[];

	return Response.json({
		conversation: {
			id: conversation.id,
			title: conversation.title,
			createdAt: conversation.created_at,
			updatedAt: conversation.updated_at,
			messages: messages.map((m) => {
				const payload = parsePayload(m.payload);
				return {
					role: m.role,
					content: m.content,
					...(payload.reasoning ? { reasoning: payload.reasoning } : {}),
					...(payload.sources ? { sources: payload.sources } : {}),
					...(payload.steps ? { steps: payload.steps } : {}),
				};
			}),
		},
	});
}

const putSchema = z.object({
	title: z.string().min(1).max(200),
});

/** Rename a conversation. Message history is owned by the chat route. */
export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await params;
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsed = putSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message ?? "Invalid request" },
			{ status: 400 },
		);
	}

	const db = getDatabase();
	const result = db
		.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
		.run(parsed.data.title, Date.now(), id);
	if (result.changes === 0) {
		return Response.json({ error: "Conversation not found" }, { status: 404 });
	}

	return Response.json({ success: true });
}

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await params;
	const db = getDatabase();

	const result = db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
	if (result.changes === 0) {
		return Response.json({ error: "Conversation not found" }, { status: 404 });
	}

	return Response.json({ success: true });
}
