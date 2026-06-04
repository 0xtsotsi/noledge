import type { Metadata } from "next";

import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
	title: "Automate",
	description:
		"Feed Noledge fresh blogs, videos, and papers while you do literally anything else.",
	path: "/automate",
});

export default function AutomateLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>): React.JSX.Element {
	return <>{children}</>;
}
