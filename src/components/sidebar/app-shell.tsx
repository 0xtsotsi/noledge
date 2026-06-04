"use client";

import { IconContext } from "@phosphor-icons/react";
import { Suspense } from "react";

import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { AppSidebar } from "./app-sidebar";

/**
 * App-wide Phosphor icon defaults. Size/color come from Tailwind `size-*` and
 * `currentColor` at each call site; this just sets the visual weight in one place
 * so the whole UI shares a consistent icon style.
 */
const ICON_DEFAULTS = { weight: "regular", size: "1em" } as const;

export function AppShell({
	children,
}: {
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<IconContext.Provider value={ICON_DEFAULTS}>
			<SidebarProvider>
				<Suspense fallback={null}>
					<AppSidebar />
				</Suspense>
				<SidebarInset className="h-svh min-w-0">
					<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
						<SidebarTrigger />
						<span className="text-sm font-semibold">Noledge</span>
					</header>
					<div className="min-h-0 flex-1">{children}</div>
				</SidebarInset>
			</SidebarProvider>
		</IconContext.Provider>
	);
}
