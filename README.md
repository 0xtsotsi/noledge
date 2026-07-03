<pre align="center">
███╗   ██╗ ██████╗ ██╗     ███████╗██████╗  ██████╗ ███████╗
████╗  ██║██╔═══██╗██║     ██╔════╝██╔══██╗██╔════╝ ██╔════╝
██╔██╗ ██║██║   ██║██║     █████╗  ██║  ██║██║  ███╗█████╗  
██║╚██╗██║██║   ██║██║     ██╔══╝  ██║  ██║██║   ██║██╔══╝  
██║ ╚████║╚██████╔╝███████╗███████╗██████╔╝╚██████╔╝███████╗
╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝
</pre>

<p align="center">
  <strong>Your own second brain that actually remembers everything.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-7C3AED?style=for-the-badge" alt="Skool"></a>
</p>

**Noledge** is a place to dump everything you read, watch, and save, then just *talk to it* like a friend who actually paid attention. PDFs, Word docs, screenshots, web articles, YouTube videos, research papers, random notes. Throw it all in. Then ask questions and get real answers, pulled straight from your own stuff.

It runs on your own computer. Your knowledge stays yours.

---

## Why this exists

We all save things we never look at again. The bookmarked article. The 2-hour video you swore you'd rewatch. The PDF buried in your downloads folder. It all just... disappears into the pile.

Noledge fixes the pile. You feed it everything, and it quietly reads, understands, and remembers all of it. Then whenever you need something, you just ask, and it answers using *your* sources, not some random thing off the internet.

It's like having a research assistant who's read everything you've ever saved and never forgets a word.

---

## The magic part (a.k.a. "RAG")

Here's the thing that makes this actually work, explained simply.

Normal AI chatbots are smart, but they only know what they were trained on. They don't know *your* notes, *your* documents, or that video you watched last Tuesday. And if you ask about something they don't know, they'll often just make stuff up.

Noledge does it differently. When you ask a question, it first goes and **finds the exact bits from your own files that matter**, then hands those to the AI to answer with. So instead of guessing, the AI is reading from your real sources every single time.

That's the whole trick. Find the right stuff first, then answer. The fancy name for it is "RAG," but you don't need to remember that. What matters is:

- **The answers come from your actual documents**, not made-up nonsense.
- **It tells you where it got each answer**, so you can trust it and dig deeper.
- **The more you add, the smarter it gets** about *your* world specifically.

You end up with an AI that knows what *you* know, plus everything you forgot.

---

## What it actually does

### Dump in anything
PDFs, Word docs, PowerPoints, spreadsheets, plain notes, web articles, even screenshots and photos of text (it reads images too). Paste a link and it grabs the article. Drop a YouTube link and it pulls the whole transcript. It all becomes searchable.

### Just ask
Chat with everything you've saved like it's one big brain. Ask a question, get an answer built from your real sources, with links back to where it came from. No more "where did I read that again?"

### The Brain
A living 3D map of everything you've added and how it all connects. Watch your knowledge grow into a glowing web of ideas. It's genuinely fun to spin around and explore.

### Automate the boring part
Tell Noledge to keep an eye on things for you. Point it at your favorite blogs, YouTube channels, or research feeds, and it'll automatically pull in new stuff as it drops, so your brain keeps growing while you sleep.

### Bring your own AI
Works with all the big AI providers (OpenAI, Anthropic/Claude, Google Gemini, DeepSeek, and more). Use whichever one you already pay for, or mix and match.

### Make it talk like you want
In Settings you can tell Noledge a bit about yourself, write your own instructions for how it should behave, and pick a response style (straight to the point, or explain-it-simply). So the answers come out the way *you* like them.

### It's all yours
Everything lives on your own computer in a single file. No cloud account, no subscription to Noledge, no one snooping on your notes.

---

## Getting started

You'll need [Node.js](https://nodejs.org) installed (grab the "LTS" version, click through the installer, done).

**1. Download the project**

```bash
git clone https://github.com/KenKaiii/noledge.git
cd noledge
```

**2. Install it**

```bash
npm install
```

**3. Start it up**

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

**4. Add your AI key(s) in the app**

Open **Settings** (in the sidebar) and go to the **Providers** tab. Click to add a key and paste it in. You'll want an OpenAI key (it powers the "memory" part), plus any others you'd like to chat with, like Claude or Gemini. Get an OpenAI key at [platform.openai.com](https://platform.openai.com/api-keys). The rest are optional, add only the ones you want.

That's it. Start dumping in your stuff and asking questions.

---

## Tips

- **Start with one thing.** Upload a single PDF or paste one article, then ask it a question. Once you see it work, you'll get the idea fast.
- **The OpenAI key is the important one.** It's what lets Noledge "understand" and remember your documents. Everything else is optional.
- **Add things over time.** This gets more useful the more you feed it. Make it a habit to drop in anything worth remembering.

---

## Community

- [YouTube @kenkaidoesai](https://youtube.com/@kenkaidoesai) - tutorials and demos
- [Skool community](https://skool.com/kenkai) - come hang out and build with us

---

## License

MIT. Do whatever you want with it.

---

<p align="center">
  <strong>Stop losing what you learn. Keep it all, and just ask.</strong>
</p>

---

## Twenty bridge

Noledge exposes an authenticated HTTP bridge under `/api/bridge/*` so external
apps (Twenty CRM, scripts, ...) can ingest CRM records, search the knowledge
base, and run grounded agent questions without touching the main UI.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/bridge/health` | Liveness check on Noledge + sqlite-vec. Returns `{ ok, bridge, database, sqliteVecVersion }`. |
| `POST` | `/api/bridge/search` | Hybrid keyword + vector search. Body: `{ query, topK?, dateFrom?, dateTo? }`. |
| `POST` | `/api/bridge/ingest` | Store a text document with source provenance. Body: `{ source, objectName, recordId, title, text, sourceUrl?, publishedAt? }`. Re-ingest of the same `(source, objectName:recordId)` pair returns `{ ok: true, duplicate: true, documentId, chunks }`. |
| `POST` | `/api/bridge/agent` | Run a grounded question. Body: `{ prompt, model?, crmContext? }`. Falls back to a retrieval-only answer when no GG-compatible provider is available or when the upstream call fails. |

### Auth

Every request must carry `x-noledge-bridge-secret: <NOLEDGE_BRIDGE_SECRET>`.
The secret comes from `.env.local` (or your platform's env) and must match
what the calling app stores in its Twenty application variables.

### Local dev proxy

Twenty runs in Docker, but Next.js 16's dev server rejects the
`host.docker.internal` Host header. To keep bridge requests flowing
cleanly, run the included Node proxy which listens on `:3001` and forwards
to Noledge on `:3000` with a sanitized `Host` header:

```bash
npm run bridge:proxy
```

Set the calling app's `NOLEDGE_BASE_URL` to `http://host.docker.internal:3001`.

### Optional GG Framework agent

When a GG-compatible provider (OpenAI, Anthropic, GLM, Kimi) is configured in
Noledge, `/api/bridge/agent` runs the question through `@kenkaiiii/gg-agent`
with three tools (`searchKnowledge`, `listRecentDocuments`, `readCrmContext`).
When no GG provider is configured, or when the upstream call fails, the
endpoint returns a retrieval-only answer that includes the CRM context plus
the agent's error message in the steps.
