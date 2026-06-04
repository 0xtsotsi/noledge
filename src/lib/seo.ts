import type { Metadata, Viewport } from "next";

const SITE_NAME = "Noledge";
const SITE_TITLE = "Noledge — your second brain, but fun";
const SITE_DESCRIPTION =
	"Chat with your notes, grow your knowledge garden, and watch your ideas connect.";
const SITE_KEYWORDS = [
	"AI knowledge base",
	"personal knowledge management",
	"second brain",
	"document chat",
	"research automation",
	"knowledge graph",
];

export function getSiteUrl(): URL {
	const candidates = [
		process.env.NEXT_PUBLIC_SITE_URL,
		process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
		"http://localhost:3000",
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			return new URL(candidate);
		} catch {}
	}
	return new URL("http://localhost:3000");
}

export const siteMetadata: Metadata = {
	metadataBase: getSiteUrl(),
	title: {
		default: SITE_TITLE,
		template: `%s · ${SITE_NAME}`,
	},
	description: SITE_DESCRIPTION,
	applicationName: SITE_NAME,
	authors: [{ name: SITE_NAME }],
	generator: "Next.js",
	keywords: SITE_KEYWORDS,
	referrer: "origin-when-cross-origin",
	creator: SITE_NAME,
	publisher: SITE_NAME,
	robots: {
		index: true,
		follow: true,
		googleBot: {
			index: true,
			follow: true,
			"max-image-preview": "large",
			"max-snippet": -1,
			"max-video-preview": -1,
		},
	},
	alternates: {
		canonical: "/",
	},
	icons: {
		icon: [
			{ url: "/favicon.ico" },
			{ url: "/icon.svg", type: "image/svg+xml" },
		],
		shortcut: "/favicon.ico",
		apple: "/icon.svg",
	},
	manifest: "/manifest.webmanifest",
	openGraph: {
		type: "website",
		locale: "en_US",
		url: "/",
		siteName: SITE_NAME,
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
	},
	twitter: {
		card: "summary",
		title: SITE_TITLE,
		description: SITE_DESCRIPTION,
	},
	appleWebApp: {
		capable: true,
		title: SITE_NAME,
		statusBarStyle: "default",
	},
	formatDetection: {
		telephone: false,
		address: false,
		email: false,
	},
};

export const siteViewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
		{ media: "(prefers-color-scheme: dark)", color: "#020617" },
	],
	colorScheme: "light dark",
};

type PageMetadataInput = Readonly<{
	title: string;
	description: string;
	path: string;
}>;

export function createPageMetadata({
	title,
	description,
	path,
}: PageMetadataInput): Metadata {
	return {
		title,
		description,
		alternates: {
			canonical: path,
		},
		openGraph: {
			title,
			description,
			url: path,
		},
		twitter: {
			title,
			description,
		},
	};
}
