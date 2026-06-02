# Plan: ChatGPT-style chat page with prompt-kit

Build the main page (`/`) as a polished, ChatGPT-style conversational UI using
[prompt-kit](https://www.prompt-kit.com/) components on top of shadcn/ui + Tailwind.

## Current state (verified)

- Bare **Next.js 16.2.7 / React 19** App Router project, code under `src/app/`.
- Path alias `@/*` → `./src/*` (tsconfig).
- **Biome** for format/lint (tabs, double quotes). Scripts: `lint`, `check`.
- **No Tailwind, no shadcn/ui, no prompt-kit** installed. `globals.css` is plain CSS.
- `src/app/page.tsx` is a placeholder `<h1>noledge</h1>`.
- prompt-kit is **not an npm package** — components are installed as source via the
  `shadcn` CLI (`npx shadcn@latest add prompt-kit/[component]`) into the repo. It needs
  Tailwind + shadcn/ui as a prerequisite.

## Design goal

A clean ChatGPT-like single page:
- Centered empty state ("What can I help with?") with the prompt input in the middle.
- After first message, transitions to a scrolling conversation with input docked at the bottom.
- Messages: user bubbles (right) + assistant markdown (left) with action buttons (copy / regenerate / feedback).
- Prompt input bar with: textarea, file upload (paperclip), image attachment chips, send/stop button, and a model/tools row.
- Assistant features showcased: **markdown** rendering, **code blocks** w/ syntax highlight, **reasoning / thinking bar**, **chain-of-thought steps**, **sources**, **image** output, **loader** while streaming.
- Light/dark via shadcn CSS variables; auto via `prefers-color-scheme`.

Because no AI provider key is assumed, wire to a **local mock streaming API route** that
returns a canned markdown answer (with code, sources metadata, reasoning) so the whole UI
works end-to-end out of the box. Structure it so swapping in a real AI SDK provider later
is a one-file change.

## Steps

### 1. Install styling + tooling deps
- Add Tailwind v4: `npm i -D tailwindcss @tailwindcss/postcss` and create `postcss.config.mjs`:
  ```js
  export default { plugins: { "@tailwindcss/postcss": {} } }
  ```
- Runtime deps prompt-kit components need: `npm i class-variance-authority clsx tailwind-merge lucide-react react-markdown remark-gfm remark-breaks marked shiki use-stick-to-bottom @radix-ui/react-tooltip @radix-ui/react-avatar @radix-ui/react-slot`.
- Rewrite `src/app/globals.css` to `@import "tailwindcss";` plus shadcn design-token CSS
  variables (`--background`, `--foreground`, `--muted`, `--primary`, `--border`, `--radius`,
  etc.) for `:root` and `.dark`, and a `@theme inline` mapping (Tailwind v4 + shadcn pattern).
  Add `@plugin "@tailwindcss/typography"` (install `@tailwindcss/typography`) for `prose` markdown styling.

### 2. shadcn/ui scaffolding (manual, no interactive CLI)
The CLI is interactive/network-driven; instead add the required files by hand to match
what prompt-kit imports:
- `src/lib/utils.ts` → `cn()` (clsx + tailwind-merge).
- `components.json` at root configured for `src/` aliases (`@/components`, `@/lib`, `tailwind` css path), so future `npx shadcn add` works too.
- shadcn primitives prompt-kit depends on, added under `src/components/ui/`:
  `button.tsx`, `textarea.tsx`, `tooltip.tsx`, `avatar.tsx`, `collapsible.tsx`, `dialog.tsx` (as needed).
  These are the standard shadcn implementations (Radix + cva).

### 3. Add prompt-kit components
Place under `src/components/prompt-kit/`. Pull the source for each from the prompt-kit
registry (`https://www.prompt-kit.com/c/<component>.json`) / GitHub
(`github.com/ibelick/prompt-kit/blob/main/components/prompt-kit/<name>.tsx`) and adapt
import paths to `@/components/ui/*` and `@/lib/utils`:
- `prompt-input.tsx` — input bar (textarea + actions).
- `chat-container.tsx` + `scroll-button.tsx` — auto-scroll conversation (uses `use-stick-to-bottom`).
- `message.tsx` — message, content, actions.
- `markdown.tsx` + `code-block.tsx` — markdown + Shiki code highlighting.
- `loader.tsx` — dots loader while streaming.
- `reasoning` / `thinking-bar.tsx` — thinking/reasoning indicator.
- `chain-of-thought.tsx` + `steps.tsx` — collapsible reasoning steps.
- `source.tsx` — website source chips with hover details.
- `image.tsx` — render image output.
- `file-upload.tsx` — drag-and-drop / picker.
- `text-shimmer.tsx` — shimmer text for loading.
- (each file's exact dep list is in its registry JSON; install any extras it references.)

### 4. Mock streaming API route
- `src/app/api/chat/route.ts` — POST handler that reads `{ messages }`, and streams back a
  canned assistant response as a `ReadableStream` of text chunks (Server-Sent-style or plain
  text stream). Include in the canned answer: a heading, paragraphs, a fenced code block, a
  list, and attach mock `sources` + `reasoning` metadata.
- Keep the provider boundary isolated in one module (`src/lib/chat-mock.ts`) so it can be
  replaced with AI SDK `streamText` later. (Avoid pulling in `ai`/`@ai-sdk` packages now to
  keep zero-key, but mirror its message shape: `{ role, parts: [{type:'text', text}] }`.)

### 5. Build the chat page
- `src/components/chat/chat.tsx` (`"use client"`) — the main orchestrator:
  - Local state: `messages`, `input`, `status` (`ready|submitting|streaming`), `files`.
  - `sendMessage()` POSTs to `/api/chat`, reads the stream, appends assistant text incrementally.
  - Empty state (centered greeting + input) vs active conversation (scrolling list + docked input).
  - Renders `ChatContainerRoot/Content`, `Message` items, `ScrollButton`.
  - Assistant message renders: `Reasoning`/`ThinkingBar` (while thinking), `ChainOfThought` steps,
    `Markdown`/`CodeBlock` body, `Source` chips, `Image` (if present), `MessageActions` (copy/regenerate/feedback).
  - User message: bubble + attached file/image chips.
  - `PromptInput` bar: `PromptInputTextarea`, `FileUpload` trigger (paperclip), image button,
    attachment preview chips with remove, send button that becomes a stop button while streaming.
- Subcomponents for clarity: `chat-message.tsx`, `chat-input-bar.tsx`.
- `src/app/page.tsx` — render `<Chat />` full-height (`flex h-svh flex-col`).
- Update `src/app/layout.tsx` `<body>` to include base bg/text classes; keep Geist fonts.

### 6. Verify
- `npm run check` (Biome format+lint+autofix) — fix any reported issues.
- `npm run build` — ensure Tailwind/PostCSS + TS compile cleanly with Next 16.
- `npm run dev` + screenshot tool at `http://localhost:3000` to visually confirm: empty
  state, sending a message, streaming response with markdown/code, reasoning bar, sources,
  file/image attachment chips, dark mode.

## Files touched / created
- `postcss.config.mjs` (new)
- `components.json` (new)
- `package.json` / `package-lock.json` (deps)
- `src/app/globals.css` (rewrite: Tailwind + shadcn tokens)
- `src/app/layout.tsx` (body classes)
- `src/app/page.tsx` (render Chat)
- `src/app/api/chat/route.ts` (new, mock stream)
- `src/lib/utils.ts`, `src/lib/chat-mock.ts` (new)
- `src/components/ui/*` (shadcn primitives: button, textarea, tooltip, avatar, collapsible)
- `src/components/prompt-kit/*` (prompt-kit components listed above)
- `src/components/chat/{chat,chat-message,chat-input-bar}.tsx` (new)

## Risks / notes
- **Tailwind v4 + shadcn token wiring** is the main fiddly part; must get `@theme inline`
  variable mapping right or utilities like `bg-background`/`text-muted-foreground` won't resolve.
- **Shiki** (code highlighting) is heavy and async; ensure the code-block component's dynamic
  highlight works under Next 16 / RSC (used in a `"use client"` tree, so fine).
- prompt-kit source occasionally references components not yet added — install transitive
  shadcn/registry deps as surfaced by each component's JSON.
- Biome uses **tabs + double quotes**; pasted component source must be reformatted via
  `npm run check` before finishing.
- No AI key: mock route keeps it runnable; real provider is a documented later swap.
