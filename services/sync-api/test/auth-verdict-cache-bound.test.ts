import { describe, expect, it, beforeEach } from "bun:test";
import {
	__resetAuthVerdictMemoryForTests,
	__verdictMemorySizeForTests,
	writeVerdictMemory,
	readVerdictMemory,
	VERDICT_MEMORY_MAX_ENTRIES,
} from "../src/auth";

/**
 * The per-isolate positive-verdict memo is keyed by sha256(userId \n token) and
 * each entry lives for the whole AUTH_CACHE_TTL window (default 900s, max
 * 3600s). Without a cap, a warm process accumulates one entry per distinct
 * (user, token) pair and only reclaims a key when that same key is read again —
 * so rotating tokens or many accounts on one process grow the map for the life
 * of the process. sync-api runs as a long-lived Bun process on a 1 GB machine.
 *
 * The Server Beta key cache already bounds its equivalent map
 * (src/server/middleware/postgres-auth.ts, VERIFIED_KEY_CACHE_MAX_ENTRIES), and
 * an evicted entry only costs that key one more upstream verification.
 */
describe("per-isolate verdict memo is bounded", () => {
	beforeEach(() => {
		__resetAuthVerdictMemoryForTests();
	});

	it("never grows past VERDICT_MEMORY_MAX_ENTRIES", () => {
		const total = VERDICT_MEMORY_MAX_ENTRIES + 250;
		for (let i = 0; i < total; i++) {
			writeVerdictMemory(`verdict:${i}`, 900);
		}
		expect(__verdictMemorySizeForTests()).toBe(VERDICT_MEMORY_MAX_ENTRIES);
	});

	it("keeps the newest verdict and evicts the oldest", () => {
		for (let i = 0; i < VERDICT_MEMORY_MAX_ENTRIES; i++) {
			writeVerdictMemory(`verdict:old-${i}`, 900);
		}
		writeVerdictMemory("verdict:newest", 900);

		expect(readVerdictMemory("verdict:newest")).toBe(true);
		expect(readVerdictMemory("verdict:old-0")).toBe(false);
		expect(__verdictMemorySizeForTests()).toBe(VERDICT_MEMORY_MAX_ENTRIES);
	});

	it("re-writing an existing key does not evict anything", () => {
		for (let i = 0; i < VERDICT_MEMORY_MAX_ENTRIES; i++) {
			writeVerdictMemory(`verdict:${i}`, 900);
		}
		// A refresh of a key already present must stay a no-op for the map size.
		writeVerdictMemory("verdict:0", 900);
		expect(__verdictMemorySizeForTests()).toBe(VERDICT_MEMORY_MAX_ENTRIES);
		expect(readVerdictMemory("verdict:0")).toBe(true);
	});

	it("drops an expired entry on read, which keeps the map from pinning it", () => {
		writeVerdictMemory("verdict:expired", 60, 0);
		expect(readVerdictMemory("verdict:expired", 61_000)).toBe(false);
		expect(__verdictMemorySizeForTests()).toBe(0);
	});
});
