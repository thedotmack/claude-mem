import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	sha256Base64Url,
	stableDocumentId,
	type CanonicalContentBody,
	type CanonicalWireOp,
} from "../src/canonical-content";
import { observationOp } from "./content-v2-helpers";

// Run with vitest.self-host.config.ts (wrangler.self-host.jsonc bindings).
const BASE = "https://hub.test";
const TOKEN = "self-host-test-token";
const USER = "self-host-user";

function headers(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		Authorization: `Bearer ${TOKEN}`,
		"X-User-Id": USER,
		"X-Device-Id": "dev-a",
		"Content-Type": "application/json",
		...overrides,
	};
}

function sealed(seed: string): Record<string, string> {
	return {
		alg: "cmem-e2e-v1",
		kid: "0123456789abcdef",
		n: "AAAAAAAAAAAAAAAA",
		ct: `${seed}-ciphertext-bytes-go-here`.replace(/[^A-Za-z0-9_-]/g, "_"),
	};
}

async function wrap(body: CanonicalContentBody): Promise<CanonicalWireOp> {
	const serialized = canonicalJson(body);
	return { body: serialized, operation_sha256: await sha256Base64Url(serialized) };
}

async function sealedObservationOp(localId: string, rev = "1", seed = localId): Promise<CanonicalWireOp> {
	const payload = sealed(seed);
	return wrap({
		body_schema_version: 1,
		deleted: false,
		deleted_at: null,
		entity_rev: rev,
		id: await stableDocumentId("observation", "dev-a", localId),
		kind: "observation",
		mutation: null,
		origin_device_id: "dev-a",
		origin_local_id: localId,
		payload,
		payload_schema_version: 2,
		payload_sha256: await sha256Base64Url(canonicalJson(payload)),
	});
}

async function sealedMutationOp(uuid: string): Promise<CanonicalWireOp> {
	return wrap({
		body_schema_version: 1,
		deleted: false,
		deleted_at: null,
		entity_rev: "1",
		id: `mutation:${uuid}`,
		kind: "mutation",
		mutation: sealed("mutation") as never,
		origin_device_id: "dev-a",
		origin_local_id: null,
		payload: null,
		payload_schema_version: 2,
		payload_sha256: await sha256Base64Url("null"),
	});
}

function push(ops: CanonicalWireOp[], extraHeaders: Record<string, string> = {}): Promise<Response> {
	return SELF.fetch(`${BASE}/v1/sync/ops`, {
		method: "POST",
		headers: headers(extraHeaders),
		body: JSON.stringify({ protocol_version: 2, ops }),
	});
}

describe("self-hosted hub: auth", () => {
	it("accepts the shared token for the configured user only", async () => {
		const status = (h: Record<string, string>) =>
			SELF.fetch(`${BASE}/v1/sync/status`, { headers: headers(h) }).then((r) => r.status);
		expect(await status({})).toBe(200);
		expect(await status({ Authorization: "Bearer wrong-token" })).toBe(401);
		expect(await status({ Authorization: "" })).toBe(401);
		expect(await status({ "X-User-Id": "someone-else" })).toBe(403);
	});

	it("hides the cmem.ai internal control plane", async () => {
		const res = await SELF.fetch(`${BASE}/internal/v1/sync/reset`, { method: "POST" });
		expect(res.status).toBe(404);
	});
});

describe("self-hosted hub: opaque payloads", () => {
	it("acks sealed ops immediately (no projector) and serves them back byte-identical", async () => {
		const ops = [await sealedObservationOp("101"), await sealedMutationOp("9a4f3c2e-1b7d-4e8a-9c3f-2d1e0b5a6c7d")];
		const res = await push(ops);
		expect(res.status).toBe(200);
		const ack = (await res.json()) as { acked: Array<{ seq: string }>; head_seq: string; projected_seq: string };
		expect(ack.acked).toHaveLength(2);
		expect(ack.projected_seq).toBe(ack.head_seq);

		const changes = await SELF.fetch(`${BASE}/v1/sync/changes?since=0&limit=500`, { headers: headers({ "X-Device-Id": "dev-b" }) });
		const page = (await changes.json()) as { ops: CanonicalWireOp[] };
		expect(page.ops.map((op) => op.body)).toEqual(expect.arrayContaining(ops.map((op) => op.body)));
	});

	it("is idempotent for the same sealed bytes and refuses different bytes at the same revision", async () => {
		const op = await sealedObservationOp("202", "1", "first");
		expect((await push([op])).status).toBe(200);
		expect((await push([op])).status).toBe(200);
		const conflicting = await sealedObservationOp("202", "1", "second");
		expect((await push([conflicting])).status).toBe(400);
	});

	it("refuses plaintext payloads so readable memories can never be stored", async () => {
		const res = await push([await observationOp("303")]);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("sealed");
	});

	it("still enforces the envelope (stable id and device binding)", async () => {
		const good = JSON.parse((await sealedObservationOp("404")).body) as CanonicalContentBody;
		const wrongId = await wrap({ ...good, id: await stableDocumentId("observation", "dev-a", "999") });
		expect((await push([wrongId])).status).toBe(400);
		expect((await push([await sealedObservationOp("405")], { "X-Device-Id": "dev-other" })).status).toBe(400);
	});
});
