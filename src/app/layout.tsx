import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/sidebar/app-shell";
import { Toaster } from "@/components/ui/sonner";
import { siteMetadata, siteViewport } from "@/lib/seo";
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = siteMetadata;

export const viewport: Viewport = siteViewport;

const themeScript = `(function(){try{var t=localStorage.getItem("noledge-theme");var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className={`${geistSans.variable} ${geistMono.variable}`}
			suppressHydrationWarning
		>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-paint theme to avoid flash */}
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
			</head>
			<body
				className="bg-background font-sans text-foreground antialiased"
				suppressHydrationWarning
			>
				<AppShell>{children}</AppShell>
				<Toaster />
			</body>
		</html>
	);
}
