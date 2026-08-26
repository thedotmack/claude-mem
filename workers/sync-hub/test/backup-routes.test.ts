/**
 * Encrypted backup routes (pro-backup plan Phase 3). Real front-Worker paths
 * via SELF.fetch with the mock verify endpoint from vitest.config.ts
 * (valid-for:<id> tokens); the R2 binding comes from wrangler.jsonc through
 * the vitest-pool-workers simulator.
 *
 * Test-sized caps from vitest.config.ts bindings: BACKUP_MAX_BYTES=4096,
 * BACKUP_RETAIN_CLOUD=3 — so over-size (413) and retention trim are
 * exercisable with kilobyte payloads.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const base = "https://sync.cmem.ai";

function headers(userId: string, deviceId = "dev-backup"): Record<string, string> {
	return {
		Authorization: `Bearer valid-for:${userId}`,
		"X-User-Id": userId,
		"X-Device-Id": deviceId,
	};
}

interface UploadUrlResponse {
	key: string;
	url: string;
}

interface ListResponse {
	objects: Array<{ key: string; size: number; uploaded: string }>;
}

async function uploadBackup(
	userId: string,
	payload: Uint8Array | string,
	deviceId = "dev-backup",
): Promise<{ key: string; putStatus: number }> {
	const urlRes = await SELF.fetch(`${base}/v1/backup/upload-url`, {
		method: "POST",
		headers: headers(userId, deviceId),
	});
	expect(urlRes.status).toBe(200);
	const { key, url } = (await urlRes.json()) as UploadUrlResponse;
	expect(key.startsWith(`backups/${userId}/${deviceId}/`)).toBe(true);
	expect(key.endsWith(".db.enc")).toBe(true);

	const putRes = await SELF.fetch(url, {
		method: "PUT",
		headers: headers(userId, deviceId),
		body: payload,
	});
	return { key, putStatus: putRes.status };
}

describe("backup routes: authentication", () => {
	it("401s every backup route without a bearer token", async () => {
		for (const [method, path] of [
			["POST", "/v1/backup/upload-url"],
			["PUT", "/v1/backup/object/1756200000000-00000000"],
			["GET", "/v1/backup/list"],
			["GET", "/v1/backup/download-url?key=backups/x/y/z.db.enc"],
			["DELETE", "/v1/backup/object?key=backups/x/y/z.db.enc"],
		] as const) {
			const res = await SELF.fetch(`${base}${path}`, { method });
			expect(res.status, `${method} ${path}`).toBe(401);
		}
	});

	it("403s a valid token presented with a mismatched X-User-Id", async () => {
		const res = await SELF.fetch(`${base}/v1/backup/list`, {
			headers: {
				Authorization: "Bearer wrong-user",
				"X-User-Id": "backup-victim",
				"X-Device-Id": "dev-backup",
			},
		});
		expect(res.status).toBe(403);
	});
});

describe("backup routes: upload + list + download round trip", () => {
	it("uploads, lists, downloads byte-identical, and deletes", async () => {
		const userId = "backup-user-roundtrip";
		const payload = crypto.getRandomValues(new Uint8Array(1024));

		const { key, putStatus } = await uploadBackup(userId, payload);
		expect(putStatus).toBe(200);

		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: headers(userId) });
		expect(listRes.status).toBe(200);
		const listed = (await listRes.json()) as ListResponse;
		expect(listed.objects.map((o) => o.key)).toContain(key);
		const entry = listed.objects.find((o) => o.key === key);
		expect(entry?.size).toBe(1024);
		expect(typeof entry?.uploaded).toBe("string");

		const downloadRes = await SELF.fetch(
			`${base}/v1/backup/download-url?key=${encodeURIComponent(key)}`,
			{ headers: headers(userId) },
		);
		expect(downloadRes.status).toBe(200);
		expect(downloadRes.headers.get("Content-Type")).toBe("application/octet-stream");
		const roundTripped = new Uint8Array(await downloadRes.arrayBuffer());
		expect(roundTripped).toEqual(payload);

		const deleteRes = await SELF.fetch(
			`${base}/v1/backup/object?key=${encodeURIComponent(key)}`,
			{ method: "DELETE", headers: headers(userId) },
		);
		expect(deleteRes.status).toBe(200);

		const afterDelete = await SELF.fetch(
			`${base}/v1/backup/download-url?key=${encodeURIComponent(key)}`,
			{ headers: headers(userId) },
		);
		expect(afterDelete.status).toBe(404);
	});

	it("rejects an invalid object id on PUT", async () => {
		const userId = "backup-user-badid";
		const res = await SELF.fetch(`${base}/v1/backup/object/../escape`, {
			method: "PUT",
			headers: headers(userId),
			body: "x",
		});
		// URL normalization or the id pattern must both refuse this — anything
		// but a 2xx write.
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe("backup routes: cross-user isolation", () => {
	it("403s download and delete of another user's key (prefix check)", async () => {
		const owner = "backup-user-owner";
		const attacker = "backup-user-attacker";
		const { key, putStatus } = await uploadBackup(owner, "owner-secret-bytes");
		expect(putStatus).toBe(200);

		const download = await SELF.fetch(
			`${base}/v1/backup/download-url?key=${encodeURIComponent(key)}`,
			{ headers: headers(attacker) },
		);
		expect(download.status).toBe(403);

		const del = await SELF.fetch(
			`${base}/v1/backup/object?key=${encodeURIComponent(key)}`,
			{ method: "DELETE", headers: headers(attacker) },
		);
		expect(del.status).toBe(403);

		// The owner's object is untouched.
		const stillThere = await SELF.fetch(
			`${base}/v1/backup/download-url?key=${encodeURIComponent(key)}`,
			{ headers: headers(owner) },
		);
		expect(stillThere.status).toBe(200);
	});

	it("list only returns the caller's own objects", async () => {
		const userA = "backup-user-list-a";
		const userB = "backup-user-list-b";
		await uploadBackup(userA, "a-bytes");
		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: headers(userB) });
		const listed = (await listRes.json()) as ListResponse;
		expect(listed.objects.every((o) => o.key.startsWith(`backups/${userB}/`))).toBe(true);
	});
});

describe("backup routes: size cap", () => {
	it("413s an upload whose Content-Length exceeds BACKUP_MAX_BYTES", async () => {
		const userId = "backup-user-oversize";
		const urlRes = await SELF.fetch(`${base}/v1/backup/upload-url`, {
			method: "POST",
			headers: headers(userId),
		});
		const { url } = (await urlRes.json()) as UploadUrlResponse;

		// 8 KiB > the 4096-byte test cap.
		const res = await SELF.fetch(url, {
			method: "PUT",
			headers: headers(userId),
			body: new Uint8Array(8192),
		});
		expect(res.status).toBe(413);

		// Nothing was stored.
		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: headers(userId) });
		const listed = (await listRes.json()) as ListResponse;
		expect(listed.objects).toEqual([]);
	});
});

describe("backup routes: add-on entitlement (Phase 4)", () => {
	function tokenHeaders(token: string, userId: string, deviceId = "dev-backup"): Record<string, string> {
		return {
			Authorization: `Bearer ${token}`,
			"X-User-Id": userId,
			"X-Device-Id": deviceId,
		};
	}

	interface AddonRequiredBody {
		error: { code: string; message: string; action: string; url: string };
	}

	it("403s addon_required on all five routes when addons exists without 'backup'", async () => {
		const userId = "backup-user-no-addon";
		// addons-for:<id>: (empty csv) → verify answers {userId, addons: []}.
		const h = tokenHeaders(`addons-for:${userId}:`, userId);
		for (const [method, path] of [
			["POST", "/v1/backup/upload-url"],
			["PUT", "/v1/backup/object/1756200000000-00000000"],
			["GET", "/v1/backup/list"],
			["GET", `/v1/backup/download-url?key=${encodeURIComponent(`backups/${userId}/dev-backup/z.db.enc`)}`],
			["DELETE", `/v1/backup/object?key=${encodeURIComponent(`backups/${userId}/dev-backup/z.db.enc`)}`],
		] as const) {
			const res = await SELF.fetch(`${base}${path}`, { method, headers: h });
			expect(res.status, `${method} ${path}`).toBe(403);
			const body = (await res.json()) as AddonRequiredBody;
			expect(body.error.code, `${method} ${path}`).toBe("addon_required");
			expect(body.error.message).toBe("Cloud backups are a cmem Pro add-on");
			expect(body.error.action).toBe("subscribe");
			expect(body.error.url).toBe("https://cmem.ai/dashboard?from=backup-addon");
		}
	});

	it("200s the full round trip when addons includes 'backup'", async () => {
		const userId = "backup-user-with-addon";
		const h = tokenHeaders(`addons-for:${userId}:backup,other`, userId);

		const urlRes = await SELF.fetch(`${base}/v1/backup/upload-url`, {
			method: "POST",
			headers: h,
		});
		expect(urlRes.status).toBe(200);
		const { key, url } = (await urlRes.json()) as UploadUrlResponse;

		const putRes = await SELF.fetch(url, { method: "PUT", headers: h, body: "entitled-bytes" });
		expect(putRes.status).toBe(200);

		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: h });
		expect(listRes.status).toBe(200);
		const listed = (await listRes.json()) as ListResponse;
		expect(listed.objects.map((o) => o.key)).toContain(key);

		const downloadRes = await SELF.fetch(
			`${base}/v1/backup/download-url?key=${encodeURIComponent(key)}`,
			{ headers: h },
		);
		expect(downloadRes.status).toBe(200);

		const deleteRes = await SELF.fetch(
			`${base}/v1/backup/object?key=${encodeURIComponent(key)}`,
			{ method: "DELETE", headers: h },
		);
		expect(deleteRes.status).toBe(200);
	});

	it("treats an absent addons field (older verify server) as entitled", async () => {
		// valid-for: tokens answer {userId} with no addons at all — the exact
		// shape today's production verify endpoint returns. Behavior unchanged.
		const userId = "backup-user-legacy-verify";
		const urlRes = await SELF.fetch(`${base}/v1/backup/upload-url`, {
			method: "POST",
			headers: headers(userId),
		});
		expect(urlRes.status).toBe(200);
		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: headers(userId) });
		expect(listRes.status).toBe(200);
	});

	it("does not gate sync routes on the addons list", async () => {
		const userId = "sync-user-no-addon";
		const res = await SELF.fetch(`${base}/v1/sync/status`, {
			headers: tokenHeaders(`addons-for:${userId}:`, userId),
		});
		expect(res.status).toBe(200);
	});
});

describe("backup routes: retention trim", () => {
	it("keeps only the BACKUP_RETAIN_CLOUD newest objects per device", async () => {
		const userId = "backup-user-retention";
		const keys: string[] = [];
		for (let i = 0; i < 5; i++) {
			const { key, putStatus } = await uploadBackup(userId, `payload-${i}`);
			expect(putStatus).toBe(200);
			keys.push(key);
		}

		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: headers(userId) });
		const listed = (await listRes.json()) as ListResponse;
		expect(listed.objects.length).toBe(3);
		// The survivors are the 3 newest uploads (ids are ms-timestamp ordered).
		const surviving = listed.objects.map((o) => o.key).sort();
		expect(surviving).toEqual([...keys].sort().slice(-3));
	});

	it("trims per device, not across devices", async () => {
		const userId = "backup-user-multi-device";
		for (let i = 0; i < 3; i++) {
			expect((await uploadBackup(userId, `a-${i}`, "device-a")).putStatus).toBe(200);
		}
		for (let i = 0; i < 2; i++) {
			expect((await uploadBackup(userId, `b-${i}`, "device-b")).putStatus).toBe(200);
		}

		const listRes = await SELF.fetch(`${base}/v1/backup/list`, { headers: headers(userId) });
		const listed = (await listRes.json()) as ListResponse;
		const deviceA = listed.objects.filter((o) => o.key.includes("/device-a/"));
		const deviceB = listed.objects.filter((o) => o.key.includes("/device-b/"));
		expect(deviceA.length).toBe(3);
		expect(deviceB.length).toBe(2);
	});
});
