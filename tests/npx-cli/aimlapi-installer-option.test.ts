// aimlapi.com is a bring-your-own-key option in the interactive installer. It
// sits below CMEM Pro, is never pre-selected, and signs in like every other
// bring-your-own provider: the CMEM Pro funnel is unchanged.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { providerNeedsAccount } from '../../src/npx-cli/commands/install.js';

const installSource = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');

describe('aimlapi.com in the installer', () => {
  it('lists aimlapi.com below CMEM Pro, with CMEM Pro still the only pre-selected option', () => {
    const start = installSource.indexOf('await p.multiselect<ProviderChoice>(');
    expect(start).toBeGreaterThan(-1);
    const menu = installSource.slice(start, installSource.indexOf('required: true', start));
    const cmemAt = menu.indexOf("{ value: 'cmem'");
    const aimlapiAt = menu.indexOf("{ value: 'aimlapi'");
    expect(cmemAt).toBeGreaterThan(-1);
    expect(aimlapiAt).toBeGreaterThan(cmemAt);
    expect(menu).toContain("initialValues: ['cmem']");
  });

  it('runs the blocking sign-in for --provider aimlapi, like the other bring-your-own providers', () => {
    expect(providerNeedsAccount('aimlapi')).toBe(true);
  });
});
