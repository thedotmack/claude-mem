/**
 * Tests for Clawdbot/Moltbot environment detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectClawdbotEnvironment, shouldUseCompatibilityMode } from '../../src/utils/clawdbot-detection.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Clawdbot Detection', () => {
  const testDir = join(tmpdir(), 'claude-mem-clawdbot-test');
  
  beforeEach(() => {
    // Create clean test directory
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
    
    // Clean up env vars
    delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    delete process.env.CLAWDBOT_GATEWAY_PORT;
    delete process.env.CLAWDBOT_PATH_BOOTSTRAPPED;
    delete process.env.CLAWDBOT_AGENT;
  });

  describe('detectClawdbotEnvironment', () => {
    it('should detect via CLAWDBOT_GATEWAY_TOKEN env var', () => {
      process.env.CLAWDBOT_GATEWAY_TOKEN = 'test-token';
      
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.detectionMethod).toBe('env:CLAWDBOT_GATEWAY_TOKEN');
    });

    it('should detect via CLAWDBOT_GATEWAY_PORT env var', () => {
      process.env.CLAWDBOT_GATEWAY_PORT = '18789';
      
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.detectionMethod).toBe('env:CLAWDBOT_GATEWAY_PORT');
    });

    it('should detect via workspace signature files (2+ files)', () => {
      // Create AGENTS.md and SOUL.md
      writeFileSync(join(testDir, 'AGENTS.md'), '# Agent Instructions');
      writeFileSync(join(testDir, 'SOUL.md'), '# Soul');
      
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('medium');
      expect(result.detectionMethod).toBe('workspace:2_signatures');
      expect(result.features.hasAgentsMd).toBe(true);
      expect(result.features.hasSoulMd).toBe(true);
    });

    it('should have high confidence with 4+ signature files', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '');
      writeFileSync(join(testDir, 'SOUL.md'), '');
      writeFileSync(join(testDir, 'HEARTBEAT.md'), '');
      writeFileSync(join(testDir, 'TOOLS.md'), '');
      
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.detected).toBe(true);
      expect(result.confidence).toBe('high');
    });

    it('should not detect with only 1 signature file', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '');
      
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.detected).toBe(false);
      expect(result.confidence).toBe('low');
    });

    it('should not detect in clean directory', () => {
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.detected).toBe(false);
      expect(result.confidence).toBe('none');
    });

    it('should track MEMORY.md feature flag', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '');
      writeFileSync(join(testDir, 'MEMORY.md'), '# Memory');
      
      const result = detectClawdbotEnvironment(testDir);
      
      expect(result.features.hasMemoryMd).toBe(true);
    });
  });

  describe('shouldUseCompatibilityMode', () => {
    it('should enable compatibility mode when Clawdbot has MEMORY.md', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '');
      writeFileSync(join(testDir, 'SOUL.md'), '');
      writeFileSync(join(testDir, 'MEMORY.md'), '');
      
      const env = detectClawdbotEnvironment(testDir);
      
      expect(shouldUseCompatibilityMode(env)).toBe(true);
    });

    it('should not enable compatibility mode without MEMORY.md', () => {
      writeFileSync(join(testDir, 'AGENTS.md'), '');
      writeFileSync(join(testDir, 'SOUL.md'), '');
      
      const env = detectClawdbotEnvironment(testDir);
      
      expect(shouldUseCompatibilityMode(env)).toBe(false);
    });

    it('should not enable compatibility mode with low confidence', () => {
      writeFileSync(join(testDir, 'MEMORY.md'), '');
      
      const env = detectClawdbotEnvironment(testDir);
      
      expect(shouldUseCompatibilityMode(env)).toBe(false);
    });
  });
});
