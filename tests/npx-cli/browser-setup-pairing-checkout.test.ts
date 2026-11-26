// On The Go's checkout on the pairing the installer holds (createPairingCheckout, which install.ts wires to cmem.ai).
// A pairing past its expiry is never opened again: the first ask or a reopen after it starts a fresh pairing, and the
// setup page gets that pairing's code before its page opens.
import { describe, expect, it } from 'bun:test';
import { createPairingCheckout, type CheckoutPairing } from '../../src/npx-cli/install/browser-setup.js';
import type { SetupDeviceCode } from '../../src/shared/setup-state.js';

// cmem.ai's checkout URL names the pairing id, never the device code.
let pairings = 0;
const pairing = (userCode: string, expiresAt?: number): CheckoutPairing => ({
  userCode, checkoutUrl: `https://cmem.ai/api/pro/trial/claim?pairing=pairing-${++pairings}`, ...(expiresAt === undefined ? {} : { expiresAt }),
});

/** Fake cmem.ai: each start hands out the next pairing; each wait on a pairing settles when the test says. */
function harness(fresh: CheckoutPairing[], options: { startFails?: boolean; startGate?: Promise<void> } = {}) {
  let clock = 1_000;
  const opened: string[] = [];
  const noted: string[] = [];
  const shown: SetupDeviceCode[] = [];
  const warnings: string[] = [];
  const waits: Array<{ code: string; opened: boolean; settle: (paid: boolean) => void; superseded: () => Promise<boolean> }> = [];
  let starts = 0;
  const checkout = createPairingCheckout({
    start: async () => {
      starts++;
      await options.startGate;
      if (options.startFails) throw new Error('Could not start the Cloud Sync sign-in.');
      return fresh.shift()!;
    },
    // Like completeCmemTrialPairing: it opens the page itself unless a reopen already did.
    complete: (next, alreadyOpened, superseded) => new Promise<boolean>(settle => {
      if (!alreadyOpened) opened.push(next.checkoutUrl);
      waits.push({ code: next.userCode, opened: alreadyOpened, settle, superseded });
    }),
    noteCode: next => noted.push(next.userCode),
    openBrowser: url => opened.push(url),
    log: { warn: message => warnings.push(message) },
    now: () => clock,
  });
  const showCode = async (code: SetupDeviceCode) => { shown.push(code); };
  return {
    checkout, showCode, opened, noted, shown, warnings, waits,
    starts: () => starts,
    at: (ms: number) => { clock = ms; },
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !check(); i++) await Bun.sleep(1);
  expect(check()).toBe(true);
}

describe('pairing checkout', () => {
  it('reopens the same page before expiry; after it, shows a fresh pairing\'s code, opens its page once, and waits on it', async () => {
    const first = pairing('AAAA-BBBB', 2_000);
    const second = pairing('CCCC-DDDD', 5_000);
    const h = harness([second]);
    h.checkout.hold(first);
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    expect(h.shown).toEqual([{ userCode: 'AAAA-BBBB', expiresAt: new Date(2_000).toISOString() }]);
    expect(h.opened).toEqual([first.checkoutUrl]);

    await h.checkout.reopen(h.showCode);
    expect(h.opened).toEqual([first.checkoutUrl, first.checkoutUrl]);
    expect(h.starts()).toBe(0);

    h.at(2_000);
    await h.checkout.reopen(h.showCode);
    expect(h.starts()).toBe(1);
    expect(h.noted).toEqual(['CCCC-DDDD']);
    expect(h.shown.at(-1)).toEqual({ userCode: 'CCCC-DDDD', expiresAt: new Date(5_000).toISOString() });
    expect(h.opened).toEqual([first.checkoutUrl, first.checkoutUrl, second.checkoutUrl]);
    // A second reopen before the fresh pairing expires opens its page, not another pairing.
    await h.checkout.reopen(h.showCode);
    expect(h.starts()).toBe(1);
    expect(h.opened.at(-1)).toBe(second.checkoutUrl);

    // The expired pairing's wait ends unpaid; the open checkout moves on to the fresh one without opening it again.
    h.waits[0].settle(false);
    await until(() => h.waits.length === 2);
    expect(h.waits[1]).toMatchObject({ code: 'CCCC-DDDD', opened: true });
    expect(h.opened.filter(url => url === second.checkoutUrl)).toHaveLength(2);
    h.waits[1].settle(true);
    expect(await run).toBe(true);
  });

  it('starts a fresh pairing for the first ask when the one the choice started has expired', async () => {
    const h = harness([pairing('CCCC-DDDD', 9_000)]);
    h.checkout.hold(pairing('AAAA-BBBB', 1_500));
    h.at(1_500);
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    expect(h.starts()).toBe(1);
    expect(h.waits[0]).toMatchObject({ code: 'CCCC-DDDD', opened: false });
    expect(h.shown.map(code => code.userCode)).toEqual(['CCCC-DDDD']);
    h.waits[0].settle(true);
    expect(await run).toBe(true);
  });

  it('keeps opening the same page when cmem.ai gave no expiry', async () => {
    const only = pairing('AAAA-BBBB');
    const h = harness([]);
    h.checkout.hold(only);
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    expect(h.shown).toEqual([{ userCode: 'AAAA-BBBB', expiresAt: null }]);
    h.at(Number.MAX_SAFE_INTEGER);
    await h.checkout.reopen(h.showCode);
    expect(h.starts()).toBe(0);
    expect(h.opened).toEqual([only.checkoutUrl, only.checkoutUrl]);
    h.waits[0].settle(true);
    expect(await run).toBe(true);
  });

  it('never reuses a pairing whose checkout failed, and lets an expired checkout fail when no fresh pairing starts', async () => {
    const h = harness([], { startFails: true });
    h.checkout.hold(pairing('AAAA-BBBB', 2_000));
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    h.at(2_000);
    await h.checkout.reopen(h.showCode);
    expect(h.warnings).toEqual(['Could not start the Cloud Sync sign-in.']);
    expect(h.shown.map(code => code.userCode)).toEqual(['AAAA-BBBB']);
    h.waits[0].settle(false);
    expect(await run).toBe(false);
    // Nothing is held now: a reopen does nothing, and the next ask must start a pairing of its own.
    await h.checkout.reopen(h.showCode);
    expect(h.starts()).toBe(1);
    await expect(h.checkout.run(h.showCode)).rejects.toThrow('Could not start the Cloud Sync sign-in.');
    expect(h.starts()).toBe(2);
  });

  it('opens no second checkout and shows no new code when the old pairing is approved while its replacement starts', async () => {
    let letStart!: () => void;
    const startGate = new Promise<void>(resolve => { letStart = resolve; });
    const first = pairing('AAAA-BBBB', 2_000);
    const h = harness([pairing('CCCC-DDDD', 9_000)], { startGate });
    h.checkout.hold(first);
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    h.at(2_000);
    const reopen = h.checkout.reopen(h.showCode);
    await until(() => h.starts() === 1);
    // The person approved the old code just before it expired: that wait ends paid while cmem.ai starts the new one.
    h.waits[0].settle(true);
    expect(await run).toBe(true);
    letStart();
    await reopen;
    expect(h.noted).toEqual([]);
    expect(h.shown.map(code => code.userCode)).toEqual(['AAAA-BBBB']);
    expect(h.opened).toEqual([first.checkoutUrl]);
  });

  it('still opens the fresh pairing\'s page and waits on it when the setup page did not take its code', async () => {
    const second = pairing('CCCC-DDDD', 9_000);
    const h = harness([second]);
    h.checkout.hold(pairing('AAAA-BBBB', 2_000));
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    h.at(2_000);
    await h.checkout.reopen(async () => { throw new Error('The worker did not take the installer stage go-awaiting-checkout (HTTP 500).'); });
    expect(h.noted).toEqual(['CCCC-DDDD']);
    expect(h.warnings).toEqual(['Could not show the device code on the setup page: The worker did not take the installer stage go-awaiting-checkout (HTTP 500).']);
    expect(h.opened.at(-1)).toBe(second.checkoutUrl);
    h.waits[0].settle(false);
    await until(() => h.waits.length === 2);
    expect(h.waits[1]).toMatchObject({ code: 'CCCC-DDDD', opened: true });
    h.waits[1].settle(true);
    expect(await run).toBe(true);
  });

  it('tells a wait it was superseded only once a fresh pairing replaced its own', async () => {
    const h = harness([pairing('CCCC-DDDD', 9_000)]);
    h.checkout.hold(pairing('AAAA-BBBB', 2_000));
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    expect(await h.waits[0].superseded()).toBe(false);
    h.at(2_000);
    await h.checkout.reopen(h.showCode);
    expect(await h.waits[0].superseded()).toBe(true);
    h.waits[0].settle(false);
    await until(() => h.waits.length === 2);
    // The fresh pairing's own wait has no replacement: its expiry is a real timeout.
    expect(await h.waits[1].superseded()).toBe(false);
    h.waits[1].settle(true);
    expect(await run).toBe(true);
  });

  it('does not call a wait superseded when its replacement could not start', async () => {
    const h = harness([], { startFails: true });
    h.checkout.hold(pairing('AAAA-BBBB', 2_000));
    const run = h.checkout.run(h.showCode);
    await until(() => h.waits.length === 1);
    h.at(2_000);
    await h.checkout.reopen(h.showCode);
    expect(await h.waits[0].superseded()).toBe(false);
    h.waits[0].settle(false);
    expect(await run).toBe(false);
  });
});
