import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { formatHostForUrl, loadEnv } from "../src/env";
import { startForwardProxy } from "../src/forward";

// A URL's host must be bracketed for an IPv6 literal. `HOST=::1` binds the
// listener fine, but the advertised URL was built as `http://::1:<port>` —
// an authority Bun and Node reject before connecting — so the `ready` event
// and every consumer of `app.url` got an unparseable address.
function supportsIpv6Loopback(): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on('error', (error: NodeJS.ErrnoException) => {
			probe.close(() => undefined);
			if (['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes(error.code ?? '')) {
				resolve(false);
			} else {
				reject(error);
			}
		});
		probe.listen(0, '::1', () => {
			probe.close(error => error ? reject(error) : resolve(true));
		});
	});
}

const ipv6LoopbackSupported = await supportsIpv6Loopback();

describe("IPv6 host in the advertised URL", () => {
	it.skipIf(!ipv6LoopbackSupported)("brackets a bare IPv6 literal so app.url parses and connects", async () => {
		const app = startForwardProxy(loadEnv({ FORWARD_ORIGIN: "https://example.com/fn", PORT: "0", HOST: "::1" }));
		try {
			// The naive `http://::1:<port>` throws "Invalid URL" here.
			const parsed = new URL(app.url);
			expect(parsed.hostname).toBe("[::1]");
			expect(app.url).toBe(`http://[::1]:${app.server.port}`);

			// The address the URL names must actually answer.
			const res = await fetch(`${app.url}/health`);
			expect(res.status).toBe(200);
		} finally {
			await app.stop();
		}
	});
});

// The pass-through rules are a pure property of the formatter, so pin them
// directly: no listener, no IPv6 requirement, and the bracketed case still
// runs on an IPv4-only host.
describe("formatHostForUrl", () => {
	it.each([
		["::1", "[::1]"],
		["2001:db8::1", "[2001:db8::1]"],
		["[::1]", "[::1]"],
		["127.0.0.1", "127.0.0.1"],
		["localhost", "localhost"],
	])("formats %s as %s", (host, expected) => {
		expect(formatHostForUrl(host)).toBe(expected);
	});
});
