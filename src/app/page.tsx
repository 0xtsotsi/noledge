import { Chat } from "@/components/chat/chat";

export default function Home(): React.JSX.Element {
	return (
		<main className="flex h-svh flex-col">
			<Chat />
		</main>
	);
}
