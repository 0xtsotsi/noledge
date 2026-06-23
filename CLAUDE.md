# Noledge — Project Orientation

A local-first "second brain" with RAG over your files, chat, and a 3D knowledge graph. Full docs: [`README.md`](./README.md).

## Stack

- **Framework:** Next.js 16.2.7 (App Router, React 19)
- **Language:** TypeScript 6
- **Linter/Formatter:** Biome 2.4 (use `npm run check` — formats + lints + imports-sorts in one pass)
- **Tests:** Vitest 4
- **Storage:** `better-sqlite3` + `sqlite-vec` (local file in `.data/`)
- **AI:** `ai` v6 + providers (OpenAI, Anthropic, Cohere, OpenAI-compatible)
- **3D graph:** `react-force-graph-3d` + `three`
- **UI:** Radix primitives + Tailwind v4 + Motion

## Local commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server on `:3000` |
| `npm run bridge:proxy` | Node proxy on `:3001` → `:3000` with sanitized `Host` (required because Next 16 rejects `host.docker.internal`) |
| `npm run test` | Vitest single run |
| `npm run test:watch` | Vitest watch mode |
| `npm run lint` | Biome lint only |
| `npm run format` | Biome format only |
| `npm run check` | Biome check + autofix (preferred over `lint`/`format`) |
| `npm run build` / `npm start` | Production build / start |

## `/api/bridge/*` contract

External apps (Twenty CRM, scripts) talk to Noledge over an authenticated HTTP bridge.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/bridge/health` | Liveness — returns `{ ok, bridge, database, sqliteVecVersion }` |
| `POST` | `/api/bridge/search` | Hybrid keyword + vector search. Body: `{ query, topK?, dateFrom?, dateTo? }` |
| `POST` | `/api/bridge/ingest` | Store a text doc with source provenance. Body: `{ source, objectName, recordId, title, text, sourceUrl?, publishedAt? }`. Same `(source, objectName:recordId)` re-ingest returns `{ ok: true, duplicate: true, documentId, chunks }` |
| `POST` | `/api/bridge/agent` | Grounded question-answering. Body: `{ prompt, model?, crmContext? }`. Falls back to retrieval-only when no GG-compatible provider is configured or the upstream call fails |

## `NOLEDGE_BRIDGE_SECRET` — required

**Every** `/api/bridge/*` request must carry header `x-noledge-bridge-secret: <NOLEDGE_BRIDGE_SECRET>`.

- Define the secret in `.env.local` (already present in this repo).
- The calling app (e.g. Twenty) must store the **same** value in its application variables.
- The proxy's `NOLEDGE_BASE_URL` for calling apps (from Docker host) is `http://host.docker.internal:3001`.

## Pointers

- Full bridge docs + Twenty integration: [`README.md` § Twenty bridge](./README.md#twenty-bridge)
- All other docs (features, getting started, tips) live in [`README.md`](./README.md)
