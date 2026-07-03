import http from "node:http";

const PORT = Number(process.env.NOLEDGE_BRIDGE_PROXY_PORT ?? 3001);
const TARGET =
	process.env.NOLEDGE_BRIDGE_PROXY_TARGET ?? "http://localhost:3000";

const server = http.createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", TARGET);
		const body = await new Promise((resolve, reject) => {
			const chunks = [];
			request.on("data", (chunk) => chunks.push(chunk));
			request.on("end", () => resolve(Buffer.concat(chunks)));
			request.on("error", reject);
		});

		const upstream = await fetch(url, {
			method: request.method,
			headers: {
				...request.headers,
				host: new URL(TARGET).host,
			},
			body:
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: body,
		});

		response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
		response.end(Buffer.from(await upstream.arrayBuffer()));
	} catch (error) {
		response.writeHead(502, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				ok: false,
				error: error instanceof Error ? error.message : "Proxy request failed.",
			}),
		);
	}
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`Noledge bridge proxy listening on http://0.0.0.0:${PORT}`);
	console.log(`Forwarding to ${TARGET}`);
});
