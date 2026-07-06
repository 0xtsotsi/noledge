import { z } from "zod";
import { retrieveChunks } from "@/lib/ai/rag/retrieve";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import { runNoledgeAgent } from "@/lib/gg/noledge-agent";
import { resolveGgModel } from "@/lib/gg/resolve-gg-model";

export const runtime = "nodejs";

const jsonRpcRequestSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number()]),
	method: z.string().min(1),
	params: z.record(z.string(), z.unknown()).optional().default({}),
});

const TOOLS = [
	{
		name: "noledge_ask",
		description: "Ask Noledge a question, grounded in the user's RAG corpus.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1 },
				model: { type: "string" },
			},
			required: ["query"],
		},
	},
	{
		name: "noledge_search",
		description: "Hybrid keyword + vector search over Noledge documents.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1 },
				topK: { type: "number", minimum: 1, maximum: 20, default: 8 },
			},
			required: ["query"],
		},
	},
	{
		name: "noledge_recall",
		description:
			"Cross-account memory recall — searches prior chats, docs, and per-user summaries.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1 },
				topK: { type: "number", minimum: 1, maximum: 20, default: 8 },
				timeRange: {
					type: "string",
					enum: ["day", "week", "month", "year", "all"],
					default: "all",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "noledge_ingest",
		description:
			"Ingest a text document into Noledge. Same shape as /api/bridge/ingest.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", minLength: 1 },
				text: { type: "string", minLength: 1 },
				source: { type: "string", default: "mcp" },
				objectName: { type: "string" },
				recordId: { type: "string" },
				sourceUrl: { type: "string" },
				publishedAt: { type: "string" },
			},
			required: ["title", "text"],
		},
	},
] as const;

/**
 * POST /api/mcp — Model Context Protocol entry point for Noledge.
 *
 * Conforms to JSON-RPC 2.0. Supports two methods:
 *   - `tools/list` → returns the TOOLS array above
 *   - `tools/call` → invokes a tool and returns its content as `{ content: [{ type: "text", text }] }`
 *
 * Exposed at http://localhost:3001/mcp via the bridge proxy. MCP clients
 * (Claude Code, Cursor, custom agents) connect to that URL and get the 4
 * tools above. Wire tools `noledge_ask` / `noledge_search` call the same
 * code paths as the bridge routes so the threat model and grounding rules
 * are identical.
 *
 * Honest disclosure: requires the operator to have configured
 * NOLEDGE_BRIDGE_SECRET (same as /api/bridge/*) AND the OAuth/API-key
 * credential for the model. v1 is read-only on the bridge side; write
 * tools require the existing tournament-approval gate (v2).
 */
export async function POST(request: Request): Promise<Response> {
	// The MCP route is auth-light by design (so MCP clients can connect with
	// just the bridge secret). For deployments that expose Noledge on a
	// public URL, the operator MUST put it behind a reverse proxy with IP
	// allow-listing — there's no per-user auth model in v1.
	const auth = validateBridgeRequest(request);
	if (!auth.ok) {
		return Response.json(
			jsonRpcError(
				null,
				-32600,
				"Unauthorized: x-noledge-bridge-secret header is missing or wrong.",
			),
		);
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json(jsonRpcError(null, -32700, "Parse error"));
	}
	const parsed = jsonRpcRequestSchema.safeParse(raw);
	if (!parsed.success) {
		return Response.json(
			jsonRpcError(
				null,
				-32600,
				`Invalid Request: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
			),
		);
	}
	const { id, method, params } = parsed.data;

	if (method === "tools/list") {
		return Response.json(jsonRpcOk(id, { tools: TOOLS }));
	}

	if (method === "tools/call") {
		const toolName = typeof params.name === "string" ? params.name : "";
		const tool = TOOLS.find((t) => t.name === toolName);
		if (!tool) {
			return Response.json(
				jsonRpcError(id, -32601, `Tool not found: ${toolName}`),
			);
		}
		try {
			const result = await callTool(toolName, params);
			return Response.json(
				jsonRpcOk(id, {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json(jsonRpcError(id, -32603, `Tool error: ${message}`));
		}
	}

	return Response.json(jsonRpcError(id, -32601, `Method not found: ${method}`));
}

async function callTool(
	name: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	if (name === "noledge_search") {
		const query = typeof params.query === "string" ? params.query : "";
		const topK = typeof params.topK === "number" ? params.topK : 8;
		const result = await retrieveChunks(query, { topK });
		return result.ok ? { chunks: result.chunks } : { error: result.error };
	}
	if (name === "noledge_ask") {
		const query = typeof params.query === "string" ? params.query : "";
		const model =
			typeof params.model === "string"
				? await resolveGgModel(params.model).catch(() => null)
				: null;
		const modelSpec =
			model && "ok" in model && model.ok
				? `${model.provider}:${model.model}`
				: undefined;
		const result = await runNoledgeAgent({
			prompt: query,
			...(modelSpec ? { model: modelSpec } : {}),
		});
		if (!result.ok) {
			return { ok: false, error: result.error };
		}
		return {
			ok: true,
			answer: result.answer,
			sources: result.sources,
		};
	}
	if (name === "noledge_recall") {
		const { crossMemoryRecall } = await import("@/lib/ai/search/cross-memory");
		const query = typeof params.query === "string" ? params.query : "";
		const topK = typeof params.topK === "number" ? params.topK : 8;
		const timeRange =
			typeof params.timeRange === "string"
				? (params.timeRange as "day" | "week" | "month" | "year" | "all")
				: "all";
		const hits = await crossMemoryRecall("default", { query, topK, timeRange });
		return { hits, total: hits.length };
	}
	if (name === "noledge_ingest") {
		const title = typeof params.title === "string" ? params.title : "";
		const text = typeof params.text === "string" ? params.text : "";
		const source = typeof params.source === "string" ? params.source : "mcp";
		const objectName =
			typeof params.objectName === "string" ? params.objectName : "mcp-doc";
		const recordId =
			typeof params.recordId === "string"
				? params.recordId
				: `mcp-${Date.now()}`;
		const { ingestText } = await import("@/lib/ai/rag/ingest");
		const result = await ingestText({
			title,
			text,
			filename: `${objectName}-${recordId}`,
			mime: "text/plain",
			bytes: text.length,
			sourceUrl:
				typeof params.sourceUrl === "string" ? params.sourceUrl : undefined,
			publishedAt:
				typeof params.publishedAt === "string"
					? Date.parse(params.publishedAt)
					: null,
		});
		if (!result.ok) return { ok: false, error: result.error };
		return {
			ok: true,
			documentId: result.documentId,
			chunks: result.chunks,
			duplicate: result.duplicate,
			source,
			objectName,
			recordId,
		};
	}
	throw new Error(`Unknown tool: ${name}`);
}

function jsonRpcOk(
	id: unknown,
	result: unknown,
): {
	jsonrpc: "2.0";
	id: unknown;
	result: unknown;
} {
	return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
	id: unknown,
	code: number,
	message: string,
): {
	jsonrpc: "2.0";
	id: unknown;
	error: { code: number; message: string };
} {
	return { jsonrpc: "2.0", id, error: { code, message } };
}
