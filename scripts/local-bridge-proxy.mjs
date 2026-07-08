import http from "node:http";

const PORT = Number(process.env.NOLEDGE_BRIDGE_PROXY_PORT ?? 3001);
const TARGET =
	process.env.NOLEDGE_BRIDGE_PROXY_TARGET ?? "http://localhost:3000";

// BP-001 (2026-07-06): default to loopback-only. The bridge proxy is a passthrough
// to http://localhost:3000 and the only protection on /api/bridge/* is the shared
// x-noledge-bridge-secret header — exposing this on the LAN means any host on the
// same network can attempt to use it. Docker callers reach the host loopback via
// host.docker.internal, so 127.0.0.1 still works for the documented Twenty-in-Docker
// setup. Operators who genuinely need LAN exposure must opt in explicitly.
const DEFAULT_BIND = "127.0.0.1";
const BIND = process.env.NOLEDGE_BRIDGE_PROXY_BIND ?? DEFAULT_BIND;

const LAN_BIND_ADDRESSES = new Set(["0.0.0.0", "::", "[::]"]);

function secretFingerprint(value) {
	if (typeof value !== "string" || value.length < 8) return "<unset>";
	return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

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

server.listen(PORT, BIND, () => {
	const isLanBind = LAN_BIND_ADDRESSES.has(BIND);
	if (isLanBind) {
		const secret = process.env.NOLEDGE_BRIDGE_SECRET ?? "";
		console.warn(
			`[noledge-bridge-proxy] WARNING: bound to ${BIND}:${PORT} — reachable from any host on the LAN.`,
		);
		console.warn(
			`[noledge-bridge-proxy] The ONLY protection on /api/bridge/* is the x-noledge-bridge-secret header.`,
		);
		console.warn(
			`[noledge-bridge-proxy] Current NOLEDGE_BRIDGE_SECRET fingerprint: ${secretFingerprint(secret)}`,
		);
		console.warn(
			`[noledge-bridge-proxy] If this value is short, default, or guessable, ROTATE IT NOW.`,
		);
		console.warn(
			`[noledge-bridge-proxy] Suggested: \`openssl rand -hex 32\`. To go loopback-only, unset NOLEDGE_BRIDGE_PROXY_BIND.`,
		);
	} else {
		console.log(`Noledge bridge proxy listening on http://${BIND}:${PORT}`);
		console.log(`Forwarding to ${TARGET}`);
	}
});
