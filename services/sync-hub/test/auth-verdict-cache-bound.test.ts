/**
 * The per-isolate positive-verdict memo is keyed by sha256(userId \n token) and
 * each entry lives for the whole AUTH_CACHE_TTL window (default 900s, max
 * 3600s). Without a cap, a warm isolate accumulates one entry per distinct
 * (user, token) pair and only reclaims a key when that same key is read again.
 *
 * Eviction costs that key one more upstream verification, never a refusal, so
 * the bound is safe to enforce aggressively.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetAuthVerdictMemoryForTests,
	__verdictMemorySizeForTests,
	VERDICT_MEMORY_MAX_ENTRIES,
	writeVerdictMemory,
	readVerdictMemory,
} from "../src/index";

describe("per-isolate verdict memo is bounded", () => {
	afterEach(() => {
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
		writeVerdictMemory("verdict:0", 900);
		expect(__verdictMemorySizeForTests()).toBe(VERDICT_MEMORY_MAX_ENTRIES);
		expect(readVerdictMemory("verdict:0")).toBe(true);
	});
});
