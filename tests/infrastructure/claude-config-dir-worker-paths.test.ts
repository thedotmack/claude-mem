import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

describe('worker scripts honor CLAUDE_CONFIG_DIR for marketplace lookup', () => {
  it('worker-cli.js does not hardcode ~/.claude marketplace root', () => {
    const workerCliPath = path.join(projectRoot, 'plugin/scripts/worker-cli.js');
    expect(existsSync(workerCliPath)).toBe(true);

    const content = readFileSync(workerCliPath, 'utf-8');
    expect(content).toContain('CLAUDE_CONFIG_DIR');
    expect(content.includes('P=S(ct(),".claude","plugins","marketplaces","thedotmack")')).toBe(false);
    expect(content.includes('ge=F.join(ut(),".claude","plugins","marketplaces","thedotmack")')).toBe(false);
  });

  it('worker-service.cjs does not hardcode ~/.claude install marker root', () => {
    const workerServicePath = path.join(projectRoot, 'plugin/scripts/worker-service.cjs');
    expect(existsSync(workerServicePath)).toBe(true);

    const content = readFileSync(workerServicePath, 'utf-8');
    expect(content).toContain('CLAUDE_CONFIG_DIR');
    expect(
      content.includes(
        'EKt=h2e.default.join((0,g2e.homedir)(),".claude","plugins","marketplaces","thedotmack","plugin",".install-version")',
      ),
    ).toBe(false);
  });
});
