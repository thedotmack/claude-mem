import { describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { SSEBroadcaster } from '../../../../src/services/worker/SSEBroadcaster.js';

// Controlled transport failures through the production broadcaster, without
// process-global mock modules or network timing assumptions.
class OwnedClient extends EventEmitter {
  readonly frames: string[] = [];
  failWrites = false;
  destroyed = false;
  writableEnded = false;
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  write(frame: string): boolean {
    if (this.failWrites) throw new Error('owned transport write failure');
    this.frames.push(frame);
    return true;
  }
}
const response = (client: OwnedClient) => client as unknown as Response;
describe('SSE transport failure isolation', () => {
  it('continues a broadcast to healthy clients after a synchronous write failure', () => {
    const broadcaster = new SSEBroadcaster();
    const failed = new OwnedClient();
    const healthy = new OwnedClient();
    broadcaster.addClient(response(failed));
    broadcaster.addClient(response(healthy));
    failed.failWrites = true;
    expect(() => broadcaster.broadcast({ type: 'processing_status', isProcessing: false })).not.toThrow();
    expect(healthy.frames.at(-1)).toContain('"processing_status"');
    expect(broadcaster.getClientCount()).toBe(1);
    expect(failed.destroyed).toBe(true);
  });
  it('handles an asynchronous response error and retains healthy delivery', () => {
    const broadcaster = new SSEBroadcaster();
    const failed = new OwnedClient();
    const healthy = new OwnedClient();
    broadcaster.addClient(response(failed));
    broadcaster.addClient(response(healthy));
    expect(() => failed.emit('error', new Error('owned async write failure'))).not.toThrow();
    broadcaster.broadcast({ type: 'processing_status', isProcessing: false });
    expect(broadcaster.getClientCount()).toBe(1);
    expect(failed.destroyed).toBe(true);
    expect(healthy.frames.at(-1)).toContain('"processing_status"');
    failed.emit('close');
    expect(failed.listenerCount('error')).toBe(0);
  });
  it('does not retain a client whose initial connection frame fails', () => {
    const broadcaster = new SSEBroadcaster();
    const failed = new OwnedClient();
    failed.failWrites = true;
    expect(() => broadcaster.addClient(response(failed))).not.toThrow();
    expect(broadcaster.getClientCount()).toBe(0);
    failed.emit('close');
  });
  it('closes an actual HTTP stream after an asynchronous response failure', async () => {
    const broadcaster = new SSEBroadcaster();
    let stream: Response | undefined;
    const app = express();
    app.get('/owned-events', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      stream = res;
      broadcaster.addClient(res);
    });
    const server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing owned listener');
      const result = await fetch(`http://127.0.0.1:${address.port}/owned-events`);
      reader = result.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('connected');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const closed = reader.read().then(value => value.done, () => true);
        stream!.emit('error', new Error('owned response failure on a live connection'));
        expect(await Promise.race([closed, new Promise<boolean>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Failed SSE stream stayed open')), 2000);
        })])).toBe(true);
        expect(broadcaster.getClientCount()).toBe(0);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      stream?.destroy();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

});
