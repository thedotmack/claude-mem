import { describe, expect, it } from 'bun:test';
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
});
