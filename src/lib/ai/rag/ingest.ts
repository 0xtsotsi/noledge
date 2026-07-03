import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { getDatabase } from "@/lib/ai/db/client";
import { embedTexts, toVectorBlob } from "@/lib/ai/embeddings/embed";
import { type ChunkOptions, chunkTextWithSpans } from "./chunk";
import { extractText } from "./extract";

function isMissingEmbeddingConfiguration(error: string): boolean {
	return error.includes("An OpenAI API key is required for embeddings");
}

/** Token-mode chunking defaults when a caller doesn't override `chunkOptions`. */
const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
	unit: "token",
	size: 400,
	overlap: 80,
};

/** Embeds a batch of strings into vectors. Injectable for tests. */
export type Embedder = (
	values: string[],
	signal?: AbortSignal,
) => Promise<
	{ ok: true; embeddings: number[][] } | { ok: false; error: string }
>;

export type IngestInput = {
	data: Buffer;
	filename: string;
	mime: string;
	title?: string;
};

/**
 * Source-agnostic ingest input: text already in hand (blog post body, video
 * transcript, …) plus the provenance needed for dedup and display. `sourceId` +
 * `externalId` key the dedup unique index; both NULL for manual uploads.
 */
export type IngestTextInput = {
	text: string;
	title: string;
	filename: string;
	mime: string;
	bytes: number;
	sourceId?: string;
	externalId?: string;
	sourceUrl?: string;
	/** Publication timestamp from the upstream source, when known. */
	publishedAt?: number | null;
};

export type IngestResult =
	| { ok: true; documentId: string; chunks: number; duplicate: boolean }
	| { ok: false; error: string };

export type IngestOptions = {
	db?: Database;
	embedder?: Embedder;
	chunkOptions?: ChunkOptions;
	signal?: AbortSignal;
};

/**
 * Ingest a document: extract text → chunk → embed → store rows + vectors in a
 * single transaction. Returns a `Result`. Delegates the chunk→embed→store tail
 * to {@link ingestText} so file uploads and feed items share one code path.
 */
export async function ingestDocument(
	input: IngestInput,
	options: IngestOptions = {},
): Promise<IngestResult> {
	const extracted = await extractText(
		input.data,
		input.filename,
		input.mime,
		options.signal,
	);
	if (!extracted.ok) return { ok: false, error: extracted.error };

	return ingestText(
		{
			text: extracted.text,
			title: input.title?.trim() || input.filename,
			filename: input.filename,
			mime: input.mime,
			bytes: input.data.byteLength,
		},
		options,
	);
}

/**
 * Ingest already-extracted text: chunk → embed → store rows + vectors + the
 * provenance columns in a single transaction. Source-agnostic — used directly by
 * the automation poller for feed items and indirectly by {@link ingestDocument}
 * for file uploads.
 */
export async function ingestText(
	input: IngestTextInput,
	options: IngestOptions = {},
): Promise<IngestResult> {
	const db = options.db ?? getDatabase();
	const embedder = options.embedder ?? embedTexts;

	const contentHash = createHash("sha256").update(input.text).digest("hex");

	// Manual uploads carry no (source_id, external_id) to dedup on, so guard them
	// by content hash: an identical upload returns the existing document instead of
	// re-embedding and storing a duplicate. Automation items keep their per-source
	// (source_id, external_id) dedup and are intentionally not deduped globally.
	if (input.sourceId === undefined) {
		const existing = db
			.prepare(
				"SELECT id FROM documents WHERE content_hash = ? AND source_id IS NULL LIMIT 1",
			)
			.get(contentHash) as { id: string } | undefined;
		if (existing) {
			const { count } = db
				.prepare("SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?")
				.get(existing.id) as { count: number };
			return {
				ok: true,
				documentId: existing.id,
				chunks: count,
				duplicate: true,
			};
		}
	}

	const chunks = chunkTextWithSpans(
		input.text,
		options.chunkOptions ?? DEFAULT_CHUNK_OPTIONS,
	);
	if (chunks.length === 0) {
		return { ok: false, error: "No extractable text found in document." };
	}

	const embedded = await embedder(
		chunks.map((chunk) => chunk.content),
		options.signal,
	);
	const storeWithoutEmbeddings =
		!embedded.ok && isMissingEmbeddingConfiguration(embedded.error);
	if (!embedded.ok && !storeWithoutEmbeddings) {
		return { ok: false, error: embedded.error };
	}
	const embeddings = embedded.ok ? embedded.embeddings : null;
	if (!storeWithoutEmbeddings && embeddings?.length !== chunks.length) {
		return { ok: false, error: "Embedding count did not match chunk count." };
	}

	const documentId = randomUUID();
	const title = input.title.trim() || input.filename;

	const insertDocument = db.prepare(
		"INSERT INTO documents (id, title, filename, mime, bytes, created_at, source_id, external_id, source_url, content_hash, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertChunk = db.prepare(
		"INSERT INTO chunks (id, document_id, ordinal, content, start, end) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertVec = db.prepare(
		"INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
	);

	const transaction = db.transaction(() => {
		insertDocument.run(
			documentId,
			title,
			input.filename,
			input.mime,
			input.bytes,
			Date.now(),
			input.sourceId ?? null,
			input.externalId ?? null,
			input.sourceUrl ?? null,
			contentHash,
			input.publishedAt ?? null,
		);
		chunks.forEach((chunk, ordinal) => {
			const chunkId = randomUUID();
			// The chunks_fts insert trigger mirrors this row into the FTS index.
			insertChunk.run(
				chunkId,
				documentId,
				ordinal,
				chunk.content,
				chunk.start,
				chunk.end,
			);
			if (storeWithoutEmbeddings) return;
			const embedding = embeddings?.[ordinal];

			if (!embedding) throw new Error("Missing embedding for chunk.");
			insertVec.run(chunkId, toVectorBlob(embedding));
		});
	});

	try {
		transaction();
	} catch (error) {
		return {
			ok: false,
			error:
				error instanceof Error ? error.message : "Failed to store document.",
		};
	}

	return { ok: true, documentId, chunks: chunks.length, duplicate: false };
}
