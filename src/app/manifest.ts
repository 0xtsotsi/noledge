import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Noledge",
		short_name: "Noledge",
		description:
			"Chat with your notes, grow your knowledge garden, and watch your ideas connect.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#ffffff",
		theme_color: "#020617",
		categories: ["productivity", "education", "utilities"],
		icons: [
			{
				src: "/icon.svg",
				type: "image/svg+xml",
				sizes: "any",
			},
		],
		shortcuts: [
			{
				name: "Chat",
				description: "Ask Noledge a question.",
				url: "/",
			},
			{
				name: "Knowledge",
				description: "Open your knowledge stash.",
				url: "/knowledge",
			},
			{
				name: "Automate",
				description: "Manage automatic source updates.",
				url: "/automate",
			},
		],
	};
}
