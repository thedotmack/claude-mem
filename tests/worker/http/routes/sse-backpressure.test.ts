import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import type { Response } from 'express';
import { SSEBroadcaster } from '../../../../src/services/worker/SSEBroadcaster.js';
class ControlledClient extends EventEmitter {
  frames: string[] = [];
  blocked = false;
  failWrites = false;
  destroyed = false;
  writableEnded = false;
  write(frame: string): boolean {
    if (this.failWrites) throw new Error('controlled write failure');
    this.frames.push(frame);
    return !this.blocked;
  }
  destroy(): this { this.destroyed = true; return this; }
  asResponse(): Response { return this as unknown as Response; }
}
const event = (id: number, text = '') => ({ type: 'processing_status', queueDepth: id, text });
describe('SSE backpressure', () => {
  it('waits for drain and preserves order without repeating the accepted false-write frame', () => {
    const broadcaster = new SSEBroadcaster();
    const client = new ControlledClient();
    broadcaster.addClient(client.asResponse());
    client.blocked = true;
    broadcaster.broadcast(event(1));
    broadcaster.broadcast(event(2));
    broadcaster.broadcast(event(3));
    expect(client.frames.length).toBe(2);
    client.blocked = false;
    client.emit('drain');
    expect(client.frames.slice(1).map(frame => JSON.parse(frame.slice(6)).queueDepth)).toEqual([1, 2, 3]);
    client.emit('drain');
    expect(client.frames.length).toBe(4);
    client.emit('close');
    expect(client.listenerCount('drain')).toBe(0);
  });
  it('stops flushing when the transport applies backpressure again', () => {
    const broadcaster = new SSEBroadcaster();
    const client = new ControlledClient();
    client.blocked = true;
    broadcaster.addClient(client.asResponse());
    broadcaster.broadcast(event(1));
    broadcaster.broadcast(event(2));
    client.emit('drain');
    expect(client.frames.length).toBe(2);
    client.blocked = false;
    client.emit('drain');
    expect(client.frames.length).toBe(3);
    client.emit('close');
  });
  it('disconnects a stalled client at the byte budget without delaying healthy clients', () => {
    const broadcaster = new SSEBroadcaster();
    const slow = new ControlledClient();
    const healthy = new ControlledClient();
    slow.blocked = true;
    broadcaster.addClient(slow.asResponse());
    broadcaster.addClient(healthy.asResponse());
    // 800 KiB UTF-8, not 400 KiB: byte accounting must not use .length.
    const payload = 'é'.repeat(400 * 1024);
    broadcaster.broadcast(event(1, payload));
    expect(slow.destroyed).toBe(false);
    broadcaster.broadcast(event(2, payload));
    expect(slow.destroyed).toBe(true);
    expect(broadcaster.getClientCount()).toBe(1);
    expect(healthy.frames.length).toBe(3);
    expect(slow.frames.length).toBe(1);
    expect(slow.listenerCount('drain')).toBe(0);
    slow.emit('drain');
    expect(slow.frames.length).toBe(1);
    slow.emit('error', new Error('late transport failure'));
    slow.emit('close');
    healthy.emit('close');
  });
  it('drops pending frames when a client is removed explicitly', () => {
    const broadcaster = new SSEBroadcaster();
    const client = new ControlledClient();
    client.blocked = true;
    broadcaster.addClient(client.asResponse());
    broadcaster.broadcast(event(1));
    broadcaster.removeClient(client.asResponse());
    client.blocked = false;
    client.emit('drain');
    expect(client.frames.length).toBe(1);
    expect(client.listenerCount('drain')).toBe(0);
    client.emit('close');
  });
});

// Exercise actual Node-compatible Writable backpressure, not only an emitter
// that returns false. The transport deliberately withholds write callbacks.
it('resumes a real Writable only after its pending write drains', async () => {
  const frames: string[] = [];
  let finishWrite: (() => void) | undefined;
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      frames.push(chunk.toString());
      finishWrite = callback;
    },
  });
  const broadcaster = new SSEBroadcaster();
  try {
    broadcaster.addClient(stream as unknown as Response);
    expect(stream.writableNeedDrain).toBe(true);
    broadcaster.broadcast(event(1));
    broadcaster.broadcast(event(2));
    expect(frames.length).toBe(1);
    finishWrite!();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(frames.length).toBe(2);
    finishWrite!();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(frames.length).toBe(3);
    finishWrite!();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(frames.slice(1).map(frame => JSON.parse(frame.slice(6)).queueDepth)).toEqual([1, 2]);
  } finally {
    stream.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(broadcaster.getClientCount()).toBe(0);
  expect(stream.listenerCount('drain')).toBe(0);
});

it('releases the pending byte budget after draining', () => {
  const broadcaster = new SSEBroadcaster();
  const client = new ControlledClient();
  client.blocked = true;
  broadcaster.addClient(client.asResponse());
  const payload = 'é'.repeat(400 * 1024);
  broadcaster.broadcast(event(1, payload));
  client.blocked = false;
  client.emit('drain');
  client.blocked = true;
  broadcaster.broadcast(event(2));
  broadcaster.broadcast(event(3, payload));
  expect(client.destroyed).toBe(false);
  client.blocked = false;
  client.emit('drain');
  expect(client.frames.length).toBe(4);
  client.emit('close');
});

it('removes a client whose queued write fails during drain', () => {
  const broadcaster = new SSEBroadcaster();
  const client = new ControlledClient();
  client.blocked = true;
  broadcaster.addClient(client.asResponse());
  broadcaster.broadcast(event(1));
  broadcaster.broadcast(event(2));
  client.failWrites = true;
  expect(() => client.emit('drain')).not.toThrow();
  expect(client.destroyed).toBe(true);
  expect(broadcaster.getClientCount()).toBe(0);
  expect(client.listenerCount('drain')).toBe(0);
  expect(client.frames.length).toBe(1);
  client.emit('close');
});
