import { describe, expect, test } from 'bun:test';
import { startViewerActivity } from '../../../src/ui/viewer/utils/viewer-activity.ts';

class Visibility extends EventTarget {
  visibilityState = 'visible';
  change(value: string) { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')); }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('local viewer activity lease', () => {
  test('renews only visible tabs and releases with monotonically increasing ownership', async () => {
    const document = new Visibility();
    const page = new EventTarget();
    const writes: Array<{ viewerId: string; visible: boolean; sequence: number }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe('/api/work-view/activity');
      expect(init?.method).toBe('POST');
      writes.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    };
    const stop = startViewerActivity({ document, page, fetchImpl, viewerId: 'tab-a', renewMs: 5 });
    try {
      await pause(15);
      expect(writes.length).toBeGreaterThan(1);
      document.change('hidden');
      await pause(1);
      expect(writes.at(-1)?.visible).toBe(false);
      const count = writes.length;
      await pause(15);
      expect(writes.length).toBe(count);
      document.change('visible');
      expect(writes.at(-1)?.visible).toBe(true);
      page.dispatchEvent(new Event('pagehide'));
      expect(writes.at(-1)?.visible).toBe(false);
      page.dispatchEvent(new Event('pageshow'));
      expect(writes.at(-1)?.visible).toBe(true);
    } finally { stop(); }
    expect(writes.at(-1)?.visible).toBe(false);
    expect(writes.every((write, index) => write.viewerId === 'tab-a' && write.sequence === index + 1)).toBe(true);
    const count = writes.length;
    document.change('visible');
    page.dispatchEvent(new Event('pageshow'));
    await pause(15);
    expect(writes.length).toBe(count);
  });

  test('cloud pages and initially hidden local pages send no lease', async () => {
    const document = new Visibility();
    const page = new EventTarget();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return new Response(null, { status: 204 }); };
    const stopCloud = startViewerActivity({ enabled: false, document, page, fetchImpl, renewMs: 5 });
    document.change('hidden');
    const stopHidden = startViewerActivity({ document, page, fetchImpl, renewMs: 5 });
    await pause(15);
    stopCloud(); stopHidden();
    expect(calls).toBe(0);
  });

  test('a hanging renewal is bounded, does not overlap periodic renewals and is superseded on hide', async () => {
    const document = new Visibility();
    const page = new EventTarget();
    const signals: AbortSignal[] = [];
    const writes: boolean[] = [];
    const fetchImpl: typeof fetch = (_url, init) => {
      signals.push(init!.signal as AbortSignal);
      writes.push(JSON.parse(String(init?.body)).visible);
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    };
    const stop = startViewerActivity({ document, page, fetchImpl, renewMs: 5, timeoutMs: 100 });
    await pause(15);
    expect(writes).toEqual([true]);
    document.change('hidden');
    expect(signals[0].aborted).toBe(true);
    expect(writes).toEqual([true, false]);
    stop();
    expect(signals[1].aborted).toBe(true);
  });
});
