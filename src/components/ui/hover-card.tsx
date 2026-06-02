"use client";

import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import type * as React from "react";

import { cn } from "@/lib/utils";

function HoverCard({
	...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>): React.JSX.Element {
	return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
	...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>): React.JSX.Element {
	return (
		<HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
	);
}

function HoverCardContent({
	className,
	align = "center",
	sideOffset = 4,
	...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>): React.JSX.Element {
	return (
		<HoverCardPrimitive.Portal data-slot="hover-card-portal">
			<HoverCardPrimitive.Content
				data-slot="hover-card-content"
				align={align}
				sideOffset={sideOffset}
				className={cn(
					"z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
					className,
				)}
				{...props}
			/>
		</HoverCardPrimitive.Portal>
	);
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
