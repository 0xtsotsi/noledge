/**
 * Mock chat provider. Mirrors the AI SDK message shape so swapping in a real
 * provider (e.g. `streamText` from `ai`) is a single-module change.
 *
 * To go live: replace `streamMockResponse` with a call to your provider and
 * pipe its text stream through the same `ChatStreamChunk` events.
 */

export type ChatRole = "user" | "assistant" | "system";

export type ChatTextPart = {
	type: "text";
	text: string;
};

export type ChatMessage = {
	id: string;
	role: ChatRole;
	parts: ChatTextPart[];
};

export type ChatSource = {
	id: string;
	href: string;
	title: string;
	description: string;
};

export type ChatReasoningStep = {
	id: string;
	label: string;
	detail: string;
};

/** Server-Sent event payloads streamed to the client. */
export type ChatStreamChunk =
	| { type: "reasoning"; text: string }
	| { type: "step"; step: ChatReasoningStep }
	| { type: "text"; text: string }
	| { type: "source"; source: ChatSource }
	| { type: "image"; url: string; alt: string }
	| { type: "done" };

function lastUserText(messages: ChatMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "user") {
			return message.parts
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
		}
	}
	return "";
}

const REASONING_STEPS: ChatReasoningStep[] = [
	{
		id: "step-parse",
		label: "Understanding the request",
		detail:
			"Parsed the prompt and identified that a code-oriented explanation is expected.",
	},
	{
		id: "step-plan",
		label: "Planning the answer",
		detail:
			"Outlined a short intro, a runnable code sample, and a list of takeaways.",
	},
	{
		id: "step-cite",
		label: "Gathering sources",
		detail: "Selected reference documentation to ground the response.",
	},
];

const SOURCES: ChatSource[] = [
	{
		id: "src-next",
		href: "https://nextjs.org/docs",
		title: "Next.js Documentation",
		description: "The App Router, streaming, and Route Handlers reference.",
	},
	{
		id: "src-promptkit",
		href: "https://www.prompt-kit.com",
		title: "prompt-kit",
		description: "Composable React components for building AI chat UIs.",
	},
];

function buildAnswer(userText: string): string {
	const topic = userText.length > 0 ? userText : "your question";
	return [
		`## Here's a quick rundown\n`,
		`You asked about **${topic}**. This is a mock streaming response that demonstrates the full chat UI — markdown, code highlighting, reasoning, sources, and an image.\n`,
		`### Example\n`,
		"Here's a small TypeScript snippet:\n",
		"```ts",
		"async function* streamWords(text: string) {",
		"\tfor (const word of text.split(/\\s+/)) {",
		"\t\tawait new Promise((r) => setTimeout(r, 30));",
		"\t\tyield word + ' ';",
		"\t}",
		"}",
		"```\n",
		"### Key takeaways\n",
		"- Streaming keeps the UI responsive while tokens arrive.",
		"- Markdown lets the assistant format rich answers.",
		"- The provider boundary lives in one module for easy swapping.\n",
		"> Swap `chat-mock.ts` for a real AI SDK provider to go live.",
	].join("\n");
}

const encoder = new TextEncoder();

function sse(chunk: ChatStreamChunk): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream a canned assistant response as Server-Sent events. Emits reasoning,
 * chain-of-thought steps, the markdown body word-by-word, sources, and an image.
 */
export function streamMockResponse(
	messages: ChatMessage[],
	signal?: AbortSignal,
): ReadableStream<Uint8Array> {
	const userText = lastUserText(messages);
	const answer = buildAnswer(userText);

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const aborted = (): boolean => signal?.aborted ?? false;
			try {
				controller.enqueue(
					sse({
						type: "reasoning",
						text: "Thinking through how to structure a helpful answer with a code example and sources.",
					}),
				);
				await delay(400);

				for (const step of REASONING_STEPS) {
					if (aborted()) break;
					controller.enqueue(sse({ type: "step", step }));
					await delay(300);
				}

				const tokens = answer.match(/\S+\s*/g) ?? [answer];
				for (const token of tokens) {
					if (aborted()) break;
					controller.enqueue(sse({ type: "text", text: token }));
					await delay(20);
				}

				for (const source of SOURCES) {
					if (aborted()) break;
					controller.enqueue(sse({ type: "source", source }));
				}

				if (!aborted()) {
					controller.enqueue(
						sse({
							type: "image",
							url: "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=640&q=80",
							alt: "Abstract streaming data visualization",
						}),
					);
				}

				controller.enqueue(sse({ type: "done" }));
			} finally {
				controller.close();
			}
		},
	});
}
