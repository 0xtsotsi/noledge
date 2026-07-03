import { NextResponse } from "next/server";
import { handleWebhookIngest } from "@/lib/ai/automate/webhook";
import { validateBridgeRequest } from "@/lib/bridge/auth";
import { errorMessage, invalidJsonResponse } from "@/lib/bridge/route-helpers";

export const runtime = "nodejs";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ sourceId: string }> },
): Promise<Response> {
	const auth = validateBridgeRequest(request);
	if (!auth.ok) return auth.response;

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return invalidJsonResponse();
	}

	const { sourceId } = await params;
	if (!sourceId) {
		return NextResponse.json(
			{ ok: false, error: "sourceId is required" },
			{ status: 400 },
		);
	}

	// Allow externalId and title to be passed via query string or headers —
	// most webhook senders (Slack, Notion, Postmark) won't put them in the body.
	const url = new URL(request.url);
	const externalId =
		url.searchParams.get("externalId") ??
		request.headers.get("x-noledge-external-id") ??
		undefined;
	const title =
		url.searchParams.get("title") ??
		request.headers.get("x-noledge-title") ??
		undefined;

	try {
		const result = await handleWebhookIngest({
			sourceId,
			payload: raw,
			externalId: externalId ?? undefined,
			title: title ?? undefined,
		});
		return NextResponse.json(result, { status: result.ok ? 200 : 422 });
	} catch (error) {
		return NextResponse.json(
			{
				ok: false,
				error: errorMessage(error, "Webhook ingest failed."),
				sourceId,
			},
			{ status: 500 },
		);
	}
}
