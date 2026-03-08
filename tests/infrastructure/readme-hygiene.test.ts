import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const readmePath = path.join(projectRoot, 'README.md');

describe('README hygiene', () => {
  it('should not include cryptocurrency promotion links', () => {
    const content = readFileSync(readmePath, 'utf-8');

    expect(content).not.toContain('Official $CMEM Links');
    expect(content).not.toContain('bags.fm');
    expect(content).not.toContain('jup.ag');
    expect(content).not.toContain('photon-sol.tinyastro.io');
    expect(content).not.toContain('dexscreener.com');
  });

  it('should not include a token contract address banner', () => {
    const content = readFileSync(readmePath, 'utf-8');

    expect(content).not.toContain('Official CA:');
    expect(content).not.toContain('on Solana');
  });
});
