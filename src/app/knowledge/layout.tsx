import type { Metadata } from "next";

import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
	title: "Knowledge",
	description:
		"Your tidy pile of PDFs, docs, images, videos, and articles for Noledge to chew on.",
	path: "/knowledge",
});

export default function KnowledgeLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>): React.JSX.Element {
	return <>{children}</>;
}
