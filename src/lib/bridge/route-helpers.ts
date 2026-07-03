import type { ZodError } from "zod";

export function invalidJsonResponse(): Response {
	return Response.json(
		{ ok: false, error: "Invalid JSON body" },
		{ status: 400 },
	);
}

export function validationErrorResponse(error: ZodError): Response {
	return Response.json(
		{ ok: false, error: "Invalid request body", issues: error.issues },
		{ status: 400 },
	);
}

export function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}
