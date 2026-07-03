import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content-Security-Policy as defense-in-depth against zero-click exfiltration
 * via injected Markdown. Even if a remote `<img>`/resource slips past the
 * renderer, `img-src`/`connect-src` keep the browser from reaching attacker
 * hosts. This app talks only to its own origin (AI providers are called
 * server-side), so all egress directives stay same-origin.
 *
 * `'unsafe-inline'`/`'unsafe-eval'` are required because Next.js injects inline
 * bootstrap scripts/styles without a nonce here; `'unsafe-eval'` is dev-only
 * (React fast-refresh). Image/connect egress remains locked down regardless.
 */
const cspDirectives = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
];

const contentSecurityPolicy = cspDirectives.join("; ");

const nextConfig: NextConfig = {
	allowedDevOrigins: [
		"host.docker.internal",
		"host.docker.internal:3000",
		"http://host.docker.internal:3000",
		"*.docker.internal",
	],
	serverExternalPackages: [
		"better-sqlite3",
		"sqlite-vec",
		"officeparser",
		"tesseract.js",
		"tesseract.js-core",
		"youtubei.js",
	],
	devIndicators: false,
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "Content-Security-Policy", value: contentSecurityPolicy },
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "Referrer-Policy", value: "no-referrer" },
				],
			},
		];
	},
};

export default nextConfig;
