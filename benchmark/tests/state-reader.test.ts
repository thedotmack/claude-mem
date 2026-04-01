import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import {
  parseTranscriptTokens,
  estimateCost,
  readAgentState,
} from '../src/judge/state-reader.js';
import type { TokenUsage } from '../src/judge/state-reader.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp-judge');

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true });
}

async function cleanupTempDir(): Promise<void> {
  try {
    await rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('state-reader', () => {
  beforeEach(async () => {
    await ensureTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  describe('parseTranscriptTokens', () => {
    test('sums token usage across multiple assistant entries', async () => {
      const transcriptContent = [
        '{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":50}}}',
        '{"type":"user","message":{}}',
        '{"type":"assistant","message":{"usage":{"input_tokens":200,"output_tokens":100,"cache_creation_input_tokens":30,"cache_read_input_tokens":10}}}',
      ].join('\n');

      const transcriptPath = join(TEMP_DIR, 'transcript.jsonl');
      await writeFile(transcriptPath, transcriptContent);

      const usage = await parseTranscriptTokens(transcriptPath);

      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(300);
      expect(usage!.outputTokens).toBe(150);
      expect(usage!.cacheCreationTokens).toBe(30);
      expect(usage!.cacheReadTokens).toBe(10);
      expect(usage!.totalTokens).toBe(490);
    });

    test('returns null for non-existent file', async () => {
      const usage = await parseTranscriptTokens(
        join(TEMP_DIR, 'nonexistent.jsonl'),
      );
      expect(usage).toBeNull();
    });

    test('returns null when no usage data is present', async () => {
      const transcriptContent = [
        '{"type":"user","message":{}}',
        '{"type":"user","message":{}}',
      ].join('\n');

      const transcriptPath = join(TEMP_DIR, 'no-usage.jsonl');
      await writeFile(transcriptPath, transcriptContent);

      const usage = await parseTranscriptTokens(transcriptPath);
      expect(usage).toBeNull();
    });

    test('skips malformed JSON lines gracefully', async () => {
      const transcriptContent = [
        '{"type":"assistant","message":{"usage":{"input_tokens":50,"output_tokens":25}}}',
        'this is not json',
        '{"type":"assistant","message":{"usage":{"input_tokens":50,"output_tokens":25}}}',
      ].join('\n');

      const transcriptPath = join(TEMP_DIR, 'malformed.jsonl');
      await writeFile(transcriptPath, transcriptContent);

      const usage = await parseTranscriptTokens(transcriptPath);

      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(100);
      expect(usage!.outputTokens).toBe(50);
      expect(usage!.totalTokens).toBe(150);
    });

    test('handles empty file', async () => {
      const transcriptPath = join(TEMP_DIR, 'empty.jsonl');
      await writeFile(transcriptPath, '');

      const usage = await parseTranscriptTokens(transcriptPath);
      expect(usage).toBeNull();
    });

    test('handles assistant entries without usage field', async () => {
      const transcriptContent = [
        '{"type":"assistant","message":{}}',
        '{"type":"assistant","message":{"usage":{"input_tokens":100,"output_tokens":50}}}',
      ].join('\n');

      const transcriptPath = join(TEMP_DIR, 'partial-usage.jsonl');
      await writeFile(transcriptPath, transcriptContent);

      const usage = await parseTranscriptTokens(transcriptPath);
      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(100);
      expect(usage!.outputTokens).toBe(50);
    });
  });

  describe('estimateCost', () => {
    test('calculates cost correctly for known token counts', () => {
      const usage: TokenUsage = {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        totalTokens: 4_000_000,
      };

      const cost = estimateCost(usage, 'claude-opus-4-6');

      // $15 + $75 + $18.75 + $1.875 = $110.625
      expect(cost).toBeCloseTo(110.625, 2);
    });

    test('returns 0 for zero tokens', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      };

      const cost = estimateCost(usage, 'claude-opus-4-6');
      expect(cost).toBe(0);
    });

    test('calculates correct cost for output-heavy usage', () => {
      const usage: TokenUsage = {
        inputTokens: 100_000,
        outputTokens: 500_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 600_000,
      };

      const cost = estimateCost(usage, 'claude-opus-4-6');
      // Input: 0.1M * $15 = $1.50
      // Output: 0.5M * $75 = $37.50
      // Total: $39.00
      expect(cost).toBeCloseTo(39.0, 2);
    });

    test('calculates correct cost for cache-heavy usage', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 2_000_000,
        cacheReadTokens: 10_000_000,
        totalTokens: 12_000_000,
      };

      const cost = estimateCost(usage, 'claude-opus-4-6');
      // Cache creation: 2M * $18.75/M = $37.50
      // Cache read: 10M * $1.875/M = $18.75
      // Total: $56.25
      expect(cost).toBeCloseTo(56.25, 2);
    });
  });

  describe('readAgentState', () => {
    test('detects DONE.md', async () => {
      const agentId = 'test-agent-done';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'DONE.md'), '# Done');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.isDone).toBe(true);
      expect(state.isCrashed).toBe(false);
      expect(state.isKilled).toBe(false);
    });

    test('detects CRASHED.md', async () => {
      const agentId = 'test-agent-crashed';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'CRASHED.md'), '# Crashed');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.isDone).toBe(false);
      expect(state.isCrashed).toBe(true);
      expect(state.isKilled).toBe(false);
    });

    test('detects KILLED.md', async () => {
      const agentId = 'test-agent-killed';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'KILLED.md'), '# Killed');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.isDone).toBe(false);
      expect(state.isCrashed).toBe(false);
      expect(state.isKilled).toBe(true);
    });

    test('counts files in agent directory', async () => {
      const agentId = 'test-agent-files';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'file1.ts'), 'content');
      await writeFile(join(agentDir, 'file2.ts'), 'content');
      await writeFile(join(agentDir, 'file3.ts'), 'content');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.fileCount).toBe(3);
    });

    test('calculates elapsed seconds from start time', async () => {
      const agentId = 'test-agent-elapsed';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });

      const startTime = new Date(Date.now() - 7200_000); // 2 hours ago
      const state = await readAgentState(agentId, TEMP_DIR, startTime);

      // Should be approximately 7200 seconds (allow some tolerance for test execution time)
      expect(state.elapsedSeconds).toBeGreaterThan(7190);
      expect(state.elapsedSeconds).toBeLessThan(7210);
    });

    test('reads transcript token usage when present', async () => {
      const agentId = 'test-agent-transcript';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, 'transcript.jsonl'),
        '{"type":"assistant","message":{"usage":{"input_tokens":500,"output_tokens":200}}}\n',
      );

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.tokenUsage).not.toBeNull();
      expect(state.tokenUsage!.inputTokens).toBe(500);
      expect(state.tokenUsage!.outputTokens).toBe(200);
      expect(state.estimatedCostUsd).toBeGreaterThan(0);
    });

    test('returns null token usage when no transcript exists', async () => {
      const agentId = 'test-agent-no-transcript';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.tokenUsage).toBeNull();
      expect(state.estimatedCostUsd).toBe(0);
    });

    test('reports running container status when no sentinel files', async () => {
      const agentId = 'test-agent-running';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'somefile.ts'), 'content');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.containerStatus).toBe('running');
    });

    test('reports exited container status when DONE.md present', async () => {
      const agentId = 'test-agent-exited';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'DONE.md'), '# Done');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.containerStatus).toBe('exited');
    });

    test('reports dead container status when CRASHED.md present', async () => {
      const agentId = 'test-agent-dead';
      const agentDir = join(TEMP_DIR, agentId);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'CRASHED.md'), '# Crashed');

      const state = await readAgentState(
        agentId,
        TEMP_DIR,
        new Date(Date.now() - 3600_000),
      );

      expect(state.containerStatus).toBe('dead');
    });
  });
});
