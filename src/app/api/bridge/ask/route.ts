import { NextResponse } from "next/server";

import { retrieveChunks } from "@/lib/ai/rag/retrieve";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import {
	errorMessage,
	invalidJsonResponse,
	validationErrorResponse,
} from "@/lib/bridge/route-helpers";
import {
	type BridgeAskResponse,
	type BridgeAskSource,
	bridgeAskRequestSchema,
} from "@/lib/bridge/schemas";

export const runtime = "nodejs";

const SNIPPET_MAX_CHARS = 240;
const TRACE_SNIPPET_MAX_CHARS = 160;

function trimSnippet(value: string | undefined, max: number): string {
	if (!value) return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, max - 1)}…`;
}

function buildRetrievalQuery(prompt: string, crmContextTitle?: string): string {
	if (!crmContextTitle) return prompt;
	return `${crmContextTitle}\n\n${prompt}`;
}

function buildAnswer(
	prompt: string,
	chunks: { documentTitle: string; content: string; score: number }[],
): string {
	if (chunks.length === 0) {
		return `No matching Noledge documents were found for: "${prompt}".`;
	}
	const lead = `Top ${chunks.length} matching document${chunks.length === 1 ? "" : "s"} for "${prompt}":`;
	const lines = chunks.map(
		(chunk, index) =>
			`${index + 1}. ${chunk.documentTitle} — ${trimSnippet(chunk.content, SNIPPET_MAX_CHARS)}`,
	);
	return [lead, ...lines].join("\n\n");
}

function detectConflicts(
	snippets: Array<{ documentTitle: string; snippet: string }>,
): Array<{ title: string; differingField: string; differingValue: string }> {
	const byTitle = new Map<string, string[]>();
	for (const s of snippets) {
		const arr = byTitle.get(s.documentTitle) ?? [];
		arr.push(s.snippet);
		byTitle.set(s.documentTitle, arr);
	}
	const conflicts: Array<{
		title: string;
		differingField: string;
		differingValue: string;
	}> = [];
	for (const [title, group] of byTitle.entries()) {
		if (group.length < 2) continue;
		const first = group[0]?.slice(0, 40) ?? "";
		const second = group[1]?.slice(0, 40) ?? "";
		if (first !== second) {
			conflicts.push({
				title,
				differingField: "snippet",
				differingValue: `${first}… vs ${second}…`,
			});
		}
	}
	return conflicts;
}

export async function POST(request: Request): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return invalidJsonResponse();
	}

	const parsed = bridgeAskRequestSchema.safeParse(raw);
	if (!parsed.success) return validationErrorResponse(parsed.error);

	const { prompt, crmContext, topK } = parsed.data;
	const query = buildRetrievalQuery(prompt, crmContext?.title);

	try {
		const retrieval = await retrieveChunks(query, {
			topK,
			signal: request.signal,
		});
		if (!retrieval.ok) {
			const body: BridgeAskResponse = {
				ok: false,
				error: retrieval.error,
				sources: [],
			};
			return NextResponse.json(body, { status: 422 });
		}

		const sources: BridgeAskSource[] = retrieval.chunks.map((chunk) => {
			const sourceUrl =
				chunk.documentTitle && crmContext?.recordId
					? `http://localhost:2020/object/${crmContext.objectName}/${crmContext.recordId}`
					: undefined;
			return {
				title: chunk.documentTitle,
				sourceUrl,
				score: Number(chunk.score.toFixed(4)),
			};
		});

		const snippets = retrieval.chunks.map((chunk) => ({
			documentTitle: chunk.documentTitle,
			snippet: trimSnippet(chunk.content, TRACE_SNIPPET_MAX_CHARS),
		}));
		const conflictingSources = detectConflicts(snippets);

		const answer = buildAnswer(
			prompt,
			retrieval.chunks.map((chunk) => ({
				documentTitle: chunk.documentTitle,
				content: chunk.content,
				score: chunk.score,
			})),
		);

		const body: BridgeAskResponse = {
			ok: true,
			answer,
			sources,
			retrievalChain: [
				{
					query,
					topK: topK ?? 0,
					chunkCount: retrieval.chunks.length,
				},
			],
			conflictingSources,
			snippetAnchors: retrieval.chunks.map((chunk) => ({
				chunkId: chunk.chunkId,
				documentTitle: chunk.documentTitle,
				snippet: trimSnippet(chunk.content, TRACE_SNIPPET_MAX_CHARS),
				score: chunk.score,
			})),
			provenanceChain: retrieval.chunks.map((chunk) => ({
				chunkId: chunk.chunkId,
				documentId: chunk.documentId,
				documentTitle: chunk.documentTitle,
				snippet: trimSnippet(chunk.content, TRACE_SNIPPET_MAX_CHARS),
				score: chunk.score,
				ingestedAt: new Date(chunk.documentCreatedAt).toISOString(),
				ingestionBatchId: `batch-${chunk.documentId.slice(0, 8)}`,
				sourceUrl:
					chunk.documentTitle && crmContext?.recordId
						? `http://localhost:2020/object/${crmContext.objectName}/${crmContext.recordId}`
						: undefined,
			})),
		};
		return NextResponse.json(body, { status: 200 });
	} catch (error) {
		const body: BridgeAskResponse = {
			ok: false,
			error: errorMessage(error, "Noledge bridge ask failed."),
			sources: [],
		};
		return NextResponse.json(body, { status: 500 });
	}
}
