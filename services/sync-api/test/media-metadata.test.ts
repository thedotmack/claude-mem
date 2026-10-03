import { describe, expect, it } from "bun:test";
import {
	CONTENT_BODY_MAX_BYTES,
	canonicalJson,
	parseCanonicalOperation,
	sha256Base64Url,
	stableDocumentId,
	type CanonicalWireOp,
} from "../src/canonical-content";
import { authHeaders, observationOp, trackedApp, uniqueUser } from "./helpers";

// Phase 5 (image-aware observations): bounded metadata.cmem_media_v1 in the
// active sync service. Forwarding stays exact; only the namespace is checked.

const ATTACHMENT_ONE = "3f8a1c2e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const ATTACHMENT_TWO = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

function mediaMetadata(manifest: unknown): Record<string, unknown> {
	return { cmem_media_v1: manifest, other_namespace: { keep: ["me", 1, true] } };
}

const VALID_MANIFEST = {
	version: 1,
	attachments: [
		{ id: ATTACHMENT_ONE, label: "event1_image1", inspection: "inspected" },
		{ id: ATTACHMENT_TWO, label: "event1_image1", inspection: "uninspected" },
	],
	overflow: false,
};

/** Builds a wire op WITHOUT validation, as a buggy or hostile client could. */
async function unvalidatedObservationOp(originLocalId: string, payloadOverrides: Record<string, unknown>): Promise<CanonicalWireOp> {
	const payload = {
		created_at: "2026-07-20T12:34:56.789Z",
		created_at_epoch: "1784550896789",
		memory_session_id: "memory-test",
		project: "/test/project",
		type: "discovery",
		...payloadOverrides,
	};
	const body = {
		body_schema_version: 1,
		deleted: false,
		deleted_at: null,
		entity_rev: "1",
		id: await stableDocumentId("observation", "dev-a", originLocalId),
		kind: "observation",
		mutation: null,
		origin_device_id: "dev-a",
		origin_local_id: originLocalId,
		payload,
		payload_schema_version: 2,
		payload_sha256: await sha256Base64Url(canonicalJson(payload)),
	};
	const serialized = canonicalJson(body);
	return { body: serialized, operation_sha256: await sha256Base64Url(serialized) };
}

const INVALID_MANIFESTS: Array<[string, unknown]> = [
	["null namespace", null],
	["unsupported version", { ...VALID_MANIFEST, version: 2 }],
	["unknown manifest key", { ...VALID_MANIFEST, ready: true }],
	["readiness frozen into a ref", { version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "event1_image1", inspection: "uninspected", state: "ready" }] }],
	["object key on a ref", { version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "event1_image1", inspection: "uninspected", key: "owner/a/b/viewer.webp" }] }],
	["path as label", { version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "/Users/me/shot.png", inspection: "uninspected" }] }],
	["data URL as label", { version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "data:image/webp;base64,AAAA", inspection: "uninspected" }] }],
	["uppercase id", { version: 1, attachments: [{ id: ATTACHMENT_ONE.toUpperCase(), label: "event1_image1", inspection: "uninspected" }] }],
	["duplicate id", { version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "a", inspection: "uninspected" }, { id: ATTACHMENT_ONE, label: "b", inspection: "uninspected" }] }],
	["bad inspection", { version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "event1_image1", inspection: "ready" }] }],
	["non-boolean overflow", { ...VALID_MANIFEST, overflow: "yes" }],
	["33 refs", {
		version: 1,
		attachments: Array.from({ length: 33 }, (_, index) => ({
			id: `3f8a1c2e-5b6d-4e7f-8a9b-${index.toString(16).padStart(12, "0")}`,
			label: "event1_image1",
			inspection: "uninspected",
		})),
	}],
];

describe("metadata.cmem_media_v1 validator (sync-api)", () => {
	it("accepts a bounded manifest and forwards the exact body with other namespaces intact", async () => {
		const op = await observationOp("1", "1", "dev-a", { metadata: mediaMetadata(VALID_MANIFEST) });
		const parsed = await parseCanonicalOperation(op);
		expect(parsed.serialized).toBe(op.body);
		expect(parsed.operationSha256).toBe(op.operation_sha256);
		expect((parsed.body.payload as Record<string, any>).metadata.other_namespace).toEqual({ keep: ["me", 1, true] });
		expect(parsed.body.payload_schema_version).toBe(2);
		expect(CONTENT_BODY_MAX_BYTES).toBe(256_000);
	});

	it("passes metadata without the namespace unchanged", async () => {
		const op = await observationOp("1", "1", "dev-a", { metadata: { other_namespace: { anything: { nested: [1] } } } });
		expect((await parseCanonicalOperation(op)).serialized).toBe(op.body);
	});

	for (const [name, manifest] of INVALID_MANIFESTS) {
		it(`fails closed on ${name}`, async () => {
			const op = await unvalidatedObservationOp("1", { metadata: mediaMetadata(manifest) });
			await expect(parseCanonicalOperation(op)).rejects.toThrow(/cmem_media_v1 is invalid/);
		});
	}

	it("still rejects an unknown top-level payload field", async () => {
		const op = await unvalidatedObservationOp("1", { attachments: [ATTACHMENT_ONE] });
		await expect(parseCanonicalOperation(op)).rejects.toThrow(/unknown field attachments/);
	});

	it("round-trips a media manifest through the hub log byte-for-byte; an invalid one is refused", async () => {
		const { app } = await trackedApp();
		const userId = uniqueUser();
		const op = await observationOp("7", "1", "dev-a", { metadata: mediaMetadata(VALID_MANIFEST) });
		const push = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [op] }),
		});
		expect(push.status).toBe(200);
		const changes = await fetch(`${app.url}/v1/sync/changes?since=0`, { headers: authHeaders(userId, "dev-b") });
		const page = await changes.json() as { ops: Array<{ body: string; operation_sha256: string }> };
		expect(page.ops).toHaveLength(1);
		expect(page.ops[0].body).toBe(op.body);
		expect(page.ops[0].operation_sha256).toBe(op.operation_sha256);

		const invalid = await unvalidatedObservationOp("8", { metadata: mediaMetadata({ version: 1, attachments: [{ id: ATTACHMENT_ONE, label: "/etc/passwd", inspection: "uninspected" }] }) });
		const refused = await fetch(`${app.url}/v1/sync/ops`, {
			method: "POST",
			headers: { ...authHeaders(userId, "dev-a"), "Content-Type": "application/json" },
			body: JSON.stringify({ protocol_version: 2, ops: [invalid] }),
		});
		expect(refused.status).toBe(400);
		const after = await fetch(`${app.url}/v1/sync/changes?since=0`, { headers: authHeaders(userId, "dev-b") });
		expect(((await after.json()) as { ops: unknown[] }).ops).toHaveLength(1);
	});
});
