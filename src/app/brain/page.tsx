import type { Metadata } from "next";

import { BrainView } from "@/components/brain/brain-view";
import { createPageMetadata } from "@/lib/seo";

export const metadata: Metadata = createPageMetadata({
	title: "The Brain",
	description:
		"A sparkly map of your documents, ideas, and all the weird little connections between them.",
	path: "/brain",
});

export default function BrainPage(): React.JSX.Element {
	return <BrainView />;
}
