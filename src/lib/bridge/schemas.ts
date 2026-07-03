import { z } from "zod";

export const bridgeCrmContextSchema = z.object({
	objectName: z.string().min(1),
	recordId: z.string().min(1),
	title: z.string().min(1),
	fields: z.record(z.string(), z.unknown()).default({}),
});

export const bridgeSearchRequestSchema = z.object({
	query: z.string().min(1),
	topK: z.number().int().min(1).max(20).optional().default(8),
	dateFrom: z.string().min(1).optional(),
	dateTo: z.string().min(1).optional(),
});

export const bridgeIngestRequestSchema = z.object({
	source: z.literal("twenty"),
	objectName: z.string().min(1),
	recordId: z.string().min(1),
	title: z.string().min(1),
	text: z.string().min(1),
	sourceUrl: z.string().url().optional(),
	publishedAt: z.string().datetime().nullable().optional(),
});

export const bridgeAgentRequestSchema = z.object({
	prompt: z.string().min(1),
	model: z.string().min(1).optional(),
	crmContext: bridgeCrmContextSchema.optional(),
});

export const bridgeAskRequestSchema = z.object({
	prompt: z.string().min(1),
	crmContext: bridgeCrmContextSchema.optional(),
	topK: z.number().int().min(1).max(20).optional().default(5),
});

export const bridgeAskSourceSchema = z.object({
	title: z.string(),
	sourceUrl: z.string().optional(),
	score: z.number(),
});

export type BridgeCrmContext = z.infer<typeof bridgeCrmContextSchema>;
export type BridgeSearchRequest = z.infer<typeof bridgeSearchRequestSchema>;
export type BridgeIngestRequest = z.infer<typeof bridgeIngestRequestSchema>;
export type BridgeAgentRequest = z.infer<typeof bridgeAgentRequestSchema>;
export type BridgeAskRequest = z.infer<typeof bridgeAskRequestSchema>;
export type BridgeAskSource = z.infer<typeof bridgeAskSourceSchema>;

export type BridgeAskResponse =
	| {
			ok: true;
			answer: string;
			sources: BridgeAskSource[];
			retrievalChain?: Array<{
				query: string;
				topK: number;
				chunkCount: number;
			}>;
			conflictingSources?: Array<{
				title: string;
				differingField: string;
				differingValue: string;
			}>;
			snippetAnchors?: Array<{
				chunkId: string;
				documentTitle: string;
				snippet: string;
				score: number;
			}>;
			provenanceChain?: Array<{
				chunkId: string;
				documentId: string;
				documentTitle: string;
				snippet: string;
				score: number;
				ingestedAt: string;
				ingestionBatchId: string;
				sourceUrl?: string;
			}>;
	  }
	| { ok: false; error: string; sources: [] };

export type BridgeSource = {
	id: string;
	title: string;
	content: string;
	score?: number;
	sourceUrl?: string;
};

export type BridgeAgentStep = {
	label: string;
	detail?: string;
};

export type BridgeClaimCitation = {
	sentence: string;
	chunkId: string;
	documentTitle: string;
	score: number;
	snippet: string;
};

export type BridgeFaithfulness = {
	score: number;
	reasoning: string;
	unsupportedClaims: string[];
};

export type BridgeAgentResponse =
	| {
			ok: true;
			answer: string;
			sources: BridgeSource[];
			steps: BridgeAgentStep[];
			claimCitations?: BridgeClaimCitation[];
			faithfulness?: BridgeFaithfulness;
	  }
	| { ok: false; error: string; sources: []; steps: [] };

export function parseIsoDate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}
