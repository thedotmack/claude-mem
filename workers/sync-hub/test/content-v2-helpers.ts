import fixture from "../../../fixtures/tpuf-content-v2.json";
import {
	canonicalJson,
	sha256Base64Url,
	stableDocumentId,
	wrapCanonicalBody,
	type CanonicalContentBody,
	type CanonicalWireOp,
} from "../src/canonical-content";

export interface OperationVector {
	name: string;
	body: string;
	operation_sha256: string;
}

export const contractFixture = fixture;

export function fixtureOp(name: string): CanonicalWireOp {
	const vector = fixture.operation_hash_vectors.find((item) => item.name === name);
	if (!vector) throw new Error(`missing operation fixture ${name}`);
	return { body: vector.body, operation_sha256: vector.operation_sha256 };
}

export async function observationOp(
	originLocalId: string,
	entityRev = "1",
	originDeviceId = "dev-a",
	overrides: Record<string, unknown> = {},
): Promise<CanonicalWireOp> {
	const payload: Record<string, unknown> = {
		created_at: "2026-07-20T12:34:56.789Z",
		created_at_epoch: "1784550896789",
		memory_session_id: "memory-test",
		project: "/test/project",
		type: "discovery",
		text: `observation ${originLocalId}`,
		...overrides,
	};
	const body: CanonicalContentBody = {
		body_schema_version: 1,
		deleted: false,
		deleted_at: null,
		entity_rev: entityRev,
		id: await stableDocumentId("observation", originDeviceId, originLocalId),
		kind: "observation",
		mutation: null,
		origin_device_id: originDeviceId,
		origin_local_id: originLocalId,
		payload,
		payload_schema_version: 2,
		payload_sha256: await sha256Base64Url(canonicalJson(payload)),
	};
	return wrapCanonicalBody(body);
}

export async function tombstoneOp(
	originLocalId: string,
	entityRev: string,
	originDeviceId = "dev-a",
): Promise<CanonicalWireOp> {
	const body: CanonicalContentBody = {
		body_schema_version: 1,
		deleted: true,
		deleted_at: "2026-07-20T13:00:00.000Z",
		entity_rev: entityRev,
		id: await stableDocumentId("observation", originDeviceId, originLocalId),
		kind: "observation",
		mutation: null,
		origin_device_id: originDeviceId,
		origin_local_id: originLocalId,
		payload: null,
		payload_schema_version: 2,
		payload_sha256: await sha256Base64Url("null"),
	};
	return wrapCanonicalBody(body);
}
