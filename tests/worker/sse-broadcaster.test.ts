import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import { SSEBroadcaster } from '../../src/services/worker/SSEBroadcaster.js';

type MockSseClient = EventEmitter & {
  writes: string[];
  write: (chunk: string) => boolean;
};

function createMockSseClient(): MockSseClient {
  const client = new EventEmitter() as MockSseClient;
  client.writes = [];
  client.write = (chunk: string) => {
    client.writes.push(chunk);
    return true;
  };
  return client;
}

describe('SSEBroadcaster', () => {
  it('sends connected event when client is added', () => {
    const broadcaster = new SSEBroadcaster(0);
    const client = createMockSseClient();

    broadcaster.addClient(client as any);

    expect(client.writes.length).toBe(1);
    expect(client.writes[0]).toContain('"type":"connected"');
  });

  it('broadcast sends events to all clients', () => {
    const broadcaster = new SSEBroadcaster(0);
    const clientA = createMockSseClient();
    const clientB = createMockSseClient();
    broadcaster.addClient(clientA as any);
    broadcaster.addClient(clientB as any);

    broadcaster.broadcast({
      type: 'processing_status',
      isProcessing: true,
      queueDepth: 2,
    });

    expect(clientA.writes.some((w) => w.includes('"type":"processing_status"'))).toBe(true);
    expect(clientB.writes.some((w) => w.includes('"type":"processing_status"'))).toBe(true);
  });

  it('sendToClient targets only the specified client', () => {
    const broadcaster = new SSEBroadcaster(0);
    const clientA = createMockSseClient();
    const clientB = createMockSseClient();
    broadcaster.addClient(clientA as any);
    broadcaster.addClient(clientB as any);

    const clientAInitialWrites = clientA.writes.length;
    const clientBInitialWrites = clientB.writes.length;

    broadcaster.sendToClient(clientA as any, {
      type: 'initial_load',
      projects: ['openclaw', 'openclaw-main'],
    });

    expect(clientA.writes.length).toBe(clientAInitialWrites + 1);
    expect(clientB.writes.length).toBe(clientBInitialWrites);
    expect(clientA.writes[clientA.writes.length - 1]).toContain('"type":"initial_load"');
  });

  it('sends keepalive heartbeats and stops after disconnect', async () => {
    const broadcaster = new SSEBroadcaster(10);
    const client = createMockSseClient();
    broadcaster.addClient(client as any);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const heartbeatWrites = client.writes.filter((w) => w.startsWith(': keepalive'));
    expect(heartbeatWrites.length).toBeGreaterThan(0);

    const writesBeforeClose = client.writes.length;
    client.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(client.writes.length).toBe(writesBeforeClose);
  });

  it('removes client on error event', () => {
    const broadcaster = new SSEBroadcaster(0);
    const client = createMockSseClient();
    broadcaster.addClient(client as any);

    expect(broadcaster.getClientCount()).toBe(1);
    client.emit('error', new Error('socket failed'));
    expect(broadcaster.getClientCount()).toBe(0);
  });
});
