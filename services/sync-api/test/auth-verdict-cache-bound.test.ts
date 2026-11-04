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

	// A refresh must not cost another key its verdict. The refreshed key is not
	// the oldest one here, so dropping the pre-insert delete in writeVerdictMemory
	// would evict verdict:0 and fail this test.
	it("refreshing a non-oldest key at capacity keeps every other key", () => {
		for (let i = 0; i < VERDICT_MEMORY_MAX_ENTRIES; i++) {
			writeVerdictMemory(`verdict:${i}`, 900);
		}
		writeVerdictMemory("verdict:5", 900);
		expect(__verdictMemorySizeForTests()).toBe(VERDICT_MEMORY_MAX_ENTRIES);
		for (let i = 0; i < VERDICT_MEMORY_MAX_ENTRIES; i++) {
			expect(readVerdictMemory(`verdict:${i}`)).toBe(true);
		}
	});

	// A refresh must also move the key to the newest position. Updating it in
	// place would leave verdict:0 first in line and fail this test.
	it("refreshing the oldest key makes the next-oldest key the one evicted", () => {
		for (let i = 0; i < VERDICT_MEMORY_MAX_ENTRIES; i++) {
			writeVerdictMemory(`verdict:${i}`, 900);
		}
		writeVerdictMemory("verdict:0", 900);
		writeVerdictMemory("verdict:new", 900);
		expect(__verdictMemorySizeForTests()).toBe(VERDICT_MEMORY_MAX_ENTRIES);
		expect(readVerdictMemory("verdict:1")).toBe(false);
		expect(readVerdictMemory("verdict:0")).toBe(true);
		expect(readVerdictMemory("verdict:2")).toBe(true);
		expect(readVerdictMemory("verdict:new")).toBe(true);
	});

	it("drops an expired entry on read, which keeps the map from pinning it", () => {
		writeVerdictMemory("verdict:expired", 60, 0);
		expect(readVerdictMemory("verdict:expired", 61_000)).toBe(false);
		expect(__verdictMemorySizeForTests()).toBe(0);
	});
});
