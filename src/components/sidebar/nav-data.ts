import {
	BookOpen,
	Brain,
	ChatText,
	FlowArrow,
	type Icon,
} from "@phosphor-icons/react";

export type NavItem = {
	readonly title: string;
	readonly href: string;
	readonly icon: Icon;
};

export const NAV_ITEMS: readonly NavItem[] = [
	{ title: "Chat", href: "/", icon: ChatText },
	{ title: "Knowledge", href: "/knowledge", icon: BookOpen },
	{ title: "Automate", href: "/automate", icon: FlowArrow },
	{ title: "The Brain", href: "/brain", icon: Brain },
];
