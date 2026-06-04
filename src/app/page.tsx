import type { Metadata } from "next";
import { Suspense } from "react";

import { Chat } from "@/components/chat/chat";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
	title: "Chat",
	description:
		"Ask questions, drop in files, and let Noledge rummage through your brainy stash.",
	path: "/",
});

export default function Home(): React.JSX.Element {
	return (
		<Suspense fallback={null}>
			<Chat />
		</Suspense>
	);
}
