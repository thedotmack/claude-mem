import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  knownMarketplaceInstallLocation,
  marketplaceDirectoryCandidates,
} from '../../src/shared/known-marketplace-location.js';

// A marketplace added from a local folder stays where the user put it; Claude
// Code records that path in plugins/known_marketplaces.json. The MCP server's
// missing-marketplace check reads it so it stops reporting a false error.
describe('knownMarketplaceInstallLocation', () => {
  let claudeConfigDirectory: string;

  beforeEach(() => {
    claudeConfigDirectory = mkdtempSync(join(tmpdir(), 'claude-mem-known-marketplaces-'));
    mkdirSync(join(claudeConfigDirectory, 'plugins'), { recursive: true });
  });
  afterEach(() => rmSync(claudeConfigDirectory, { recursive: true, force: true }));

  const writeKnownMarketplaces = (content: string): void =>
    writeFileSync(join(claudeConfigDirectory, 'plugins', 'known_marketplaces.json'), content);

  it('returns the leoli-goat installLocation recorded for a directory-source marketplace', () => {
    const localCheckout = join(claudeConfigDirectory, 'my-claude-mem-checkout');
    writeKnownMarketplaces(JSON.stringify({
      'leoli-goat': { source: { source: 'directory', path: localCheckout }, installLocation: localCheckout },
    }));
    expect(knownMarketplaceInstallLocation(claudeConfigDirectory)).toBe(localCheckout);
  });

  it('returns null when known_marketplaces.json is missing', () => {
    expect(knownMarketplaceInstallLocation(claudeConfigDirectory)).toBeNull();
  });

  it('returns null when known_marketplaces.json is malformed', () => {
    writeKnownMarketplaces('{ not json');
    expect(knownMarketplaceInstallLocation(claudeConfigDirectory)).toBeNull();
  });

  it('returns null when there is no leoli-goat entry or it has no installLocation', () => {
    writeKnownMarketplaces(JSON.stringify({ other: { installLocation: '/somewhere' }, 'leoli-goat': {} }));
    expect(knownMarketplaceInstallLocation(claudeConfigDirectory)).toBeNull();
  });

  it('makes an existing recorded installLocation count as a present marketplace', () => {
    const emptyHome = join(claudeConfigDirectory, 'home');
    const localCheckout = join(claudeConfigDirectory, 'my-claude-mem-checkout');
    expect(marketplaceDirectoryCandidates(emptyHome, claudeConfigDirectory).some(existsSync)).toBe(false);

    mkdirSync(localCheckout);
    writeKnownMarketplaces(JSON.stringify({ 'leoli-goat': { installLocation: localCheckout } }));
    const candidates = marketplaceDirectoryCandidates(emptyHome, claudeConfigDirectory);
    expect(candidates).toEqual([
      join(emptyHome, '.claude', 'plugins', 'marketplaces', 'leoli-goat'),
      join(emptyHome, '.config', 'claude', 'plugins', 'marketplaces', 'leoli-goat'),
      localCheckout,
    ]);
    expect(candidates.some(existsSync)).toBe(true);
  });
});
