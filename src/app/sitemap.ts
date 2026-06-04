import type { MetadataRoute } from "next";

import { getSiteUrl } from "@/lib/seo";

const ROUTES = ["/", "/knowledge", "/automate", "/brain"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
	const siteUrl = getSiteUrl();
	return ROUTES.map((route) => ({
		url: new URL(route, siteUrl).toString(),
		changeFrequency: "weekly",
		priority: route === "/" ? 1 : 0.8,
	}));
}
