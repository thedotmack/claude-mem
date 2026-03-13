/**
 * Tests for detectPlatform() — auto-detects Factory/Droid CLI vs Claude Code
 * based on environment variables.
 *
 * Factory/Droid sets DROID_PLUGIN_ROOT alongside CLAUDE_PLUGIN_ROOT.
 * When the caller passes 'claude-code' (the default), detectPlatform checks
 * for DROID_PLUGIN_ROOT to distinguish the two platforms.
 * Explicit non-default platforms (e.g., 'cursor') pass through unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { detectPlatform } from '../../src/cli/hook-command.js';

let originalDroidPluginRoot: string | undefined;

beforeEach(() => {
  originalDroidPluginRoot = process.env.DROID_PLUGIN_ROOT;
});

afterEach(() => {
  if (originalDroidPluginRoot !== undefined) {
    process.env.DROID_PLUGIN_ROOT = originalDroidPluginRoot;
  } else {
    delete process.env.DROID_PLUGIN_ROOT;
  }
});

describe('detectPlatform', () => {
  it('should return "droid" when platform is "claude-code" and DROID_PLUGIN_ROOT is set', () => {
    process.env.DROID_PLUGIN_ROOT = '/some/factory/path';
    expect(detectPlatform('claude-code')).toBe('droid');
  });

  it('should return "claude-code" when platform is "claude-code" and DROID_PLUGIN_ROOT is NOT set', () => {
    delete process.env.DROID_PLUGIN_ROOT;
    expect(detectPlatform('claude-code')).toBe('claude-code');
  });

  it('should return "cursor" regardless of DROID_PLUGIN_ROOT when platform is "cursor"', () => {
    // Without DROID_PLUGIN_ROOT
    delete process.env.DROID_PLUGIN_ROOT;
    expect(detectPlatform('cursor')).toBe('cursor');

    // With DROID_PLUGIN_ROOT — explicit non-default platforms are respected
    process.env.DROID_PLUGIN_ROOT = '/some/factory/path';
    expect(detectPlatform('cursor')).toBe('cursor');
  });
});
