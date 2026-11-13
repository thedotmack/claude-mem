import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Application, Request, Response } from 'express';
import { SSEBroadcaster } from '../../../../src/services/worker/SSEBroadcaster.js';
import { ViewerRoutes } from '../../../../src/services/worker/http/routes/ViewerRoutes.js';
import type { DatabaseManager } from '../../../../src/services/worker/DatabaseManager.js';
import type { SessionManager } from '../../../../src/services/worker/SessionManager.js';

class Viewer extends EventEmitter {
  readonly frames: Array<{ type: string; queueDepth?: number; projects?: string[] }> = [];
  destroyed = false;
  writableEnded = false;
  setHeader() { return this; }
  write(frame: string): boolean {
    this.frames.push(JSON.parse(frame.slice(6)));
    return true;
  }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
  asResponse(): Response { return this as unknown as Response; }
}

function harness() {
  const broadcaster = new SSEBroadcaster();
  let stream!: (req: Request, res: Response) => void;
  const catalog = { projects: ['project'], sources: ['claude-code'], projectsBySource: {} };
  const state = { processing: async () => false };
  const routes = new ViewerRoutes(broadcaster, {
    getSessionStore: () => ({ getProjectCatalog: () => catalog }),
  } as unknown as DatabaseManager, {
    isAnySessionProcessing: () => state.processing(),
    getTotalActiveWork: async () => 0,
  } as unknown as SessionManager);
  routes.setupRoutes({
    use() {},
    get(path: string, handler: typeof stream) { if (path === '/stream') stream = handler; },
  } as unknown as Application);
  const viewers: Viewer[] = [];
  return {
    broadcaster, state,
    connect() {
      const viewer = new Viewer(); viewers.push(viewer);
      stream({ path: '/stream' } as Request, viewer.asResponse());
      return viewer;
    },
    close() { for (const viewer of viewers) viewer.destroy(); },
  };
}

// Let the handler's initial async status reads settle, with no wall-clock sleep.
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

describe('viewer connection snapshots', () => {
  it('sends the catalog and initial status only to the joining viewer', async () => {
    const h = harness();
    try {
      const first = h.connect(); await settled();
      const second = h.connect(); await settled();
      for (const viewer of [first, second]) {
        expect(viewer.frames.map(frame => frame.type)).toEqual(['connected', 'initial_load', 'processing_status']);
        expect(viewer.frames[1].projects).toEqual(['project']);
      }
    } finally { h.close(); }
  });

  it('keeps initial snapshot delivery linear across twenty sequential connections', async () => {
    const h = harness();
    try {
      const viewers: Viewer[] = [];
      for (let index = 0; index < 20; index++) { viewers.push(h.connect()); await settled(); }
      expect(viewers.reduce((count, viewer) => count + viewer.frames.length, 0)).toBe(60);
      expect(h.broadcaster.getClientCount()).toBe(20);
    } finally { h.close(); }
  });

  it('does not broadcast a departed viewer\'s delayed initial status over a live update', async () => {
    const h = harness();
    try {
      const first = h.connect(); await settled();
      let release!: (value: boolean) => void;
      h.state.processing = () => new Promise<boolean>(resolve => { release = resolve; });
      const departed = h.connect();
      departed.destroy();
      h.broadcaster.broadcast({ type: 'processing_status', isProcessing: true, queueDepth: 9 });
      release(false); await settled();
      expect(first.frames.at(-1)?.queueDepth).toBe(9);
      expect(departed.frames.map(frame => frame.type)).toEqual(['connected', 'initial_load']);
    } finally { h.close(); }
  });

  it('still broadcasts actual live updates to every connected viewer', async () => {
    const h = harness();
    try {
      const first = h.connect(); const second = h.connect(); await settled();
      h.broadcaster.broadcast({ type: 'processing_status', isProcessing: true, queueDepth: 5 });
      expect(first.frames.at(-1)?.queueDepth).toBe(5);
      expect(second.frames.at(-1)?.queueDepth).toBe(5);
    } finally { h.close(); }
  });
});
