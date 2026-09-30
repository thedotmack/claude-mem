#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createSyncHubMiniflare } from "./miniflare-pro-e2e-node.mjs";

function argumentsByName(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index++) {
		const token = argv[index];
		if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
		const equals = token.indexOf("=");
		if (equals !== -1) {
			values.set(token.slice(2, equals), token.slice(equals + 1));
			continue;
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${token}`);
		values.set(token.slice(2), value);
		index++;
	}
	return values;
}

function required(value, name) {
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function parsePort(value) {
	if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value)) throw new Error("port must be 0 through 65535");
	const port = Number(value);
	if (port > 65_535) throw new Error("port must be 0 through 65535");
	return port;
}

const args = argumentsByName(process.argv.slice(2));
const workerRoot = args.get("worker-root")
	?? process.env.CMEM_HUB_WORKER_ROOT
	?? fileURLToPath(new URL("..", import.meta.url));
const host = args.get("host") ?? process.env.SYNC_HUB_HOST ?? "127.0.0.1";
const port = parsePort(args.get("port") ?? process.env.SYNC_HUB_PORT ?? "0");
const internalProjectorUrl = required(
	args.get("projector-url") ?? process.env.INTERNAL_PROJECTOR_URL,
	"INTERNAL_PROJECTOR_URL/--projector-url",
);
const tokenVerifyUrl = required(
	args.get("verify-url") ?? process.env.TOKEN_VERIFY_URL,
	"TOKEN_VERIFY_URL/--verify-url",
);
const internalProjectorSecret = required(
	args.get("projector-secret") ?? process.env.CMEM_INTERNAL_PROJECTOR_SECRET,
	"CMEM_INTERNAL_PROJECTOR_SECRET/--projector-secret",
);

const stop = new Promise((resolve) => {
	process.once("SIGINT", () => resolve("SIGINT"));
	process.once("SIGTERM", () => resolve("SIGTERM"));
});
const wrapperSignalListeners = new Map([
	["SIGINT", new Set(process.listeners("SIGINT"))],
	["SIGTERM", new Set(process.listeners("SIGTERM"))],
]);

let miniflare;
try {
	miniflare = await createSyncHubMiniflare({
		workerRoot,
		internalProjectorUrl,
		tokenVerifyUrl,
		internalProjectorSecret,
		host,
		port,
	});
	// Miniflare's library exit hook normally maps SIGTERM to immediate exit 143.
	// This wrapper owns lifecycle instead: retain pre-existing wrapper listeners,
	// remove only listeners Miniflare added, then await dispose() below.
	for (const [signal, retained] of wrapperSignalListeners) {
		for (const listener of process.listeners(signal)) {
			if (!retained.has(listener)) process.removeListener(signal, listener);
		}
	}
	const readyUrl = await miniflare.ready;
	process.stdout.write(`${JSON.stringify({ event: "ready", url: readyUrl.href, pid: process.pid })}\n`);

	const signal = await stop;
	await miniflare.dispose();
	miniflare = undefined;
	process.stdout.write(`${JSON.stringify({ event: "stopped", signal })}\n`);
} catch (error) {
	if (miniflare) await miniflare.dispose();
	process.stderr.write(`${JSON.stringify({
		event: "error",
		message: error instanceof Error ? error.message : String(error),
	})}\n`);
	process.exitCode = 1;
}
