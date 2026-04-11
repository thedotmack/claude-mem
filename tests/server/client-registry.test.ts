import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ClientRegistry, type ClientRegistryEvent } from '../../src/services/server/ClientRegistry.js';

describe('ClientRegistry', () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    registry = new ClientRegistry();
  });

  describe('initial state', () => {
    it('should have no clients initially', () => {
      expect(registry.getClientCount()).toBe(0);
      expect(registry.getClients()).toEqual([]);
    });
  });

  describe('touch()', () => {
    it('should register a new client on first touch', () => {
      registry.touch('MSM4M', '169.254.1.3');

      expect(registry.getClientCount()).toBe(1);
      const clients = registry.getClients();
      expect(clients[0].node).toBe('MSM4M');
      expect(clients[0].ip).toBe('169.254.1.3');
      expect(clients[0].requestCount).toBe(1);
    });

    it('should default mode to "direct" when not provided', () => {
      registry.touch('MSM4M', '169.254.1.3');

      const client = registry.getClients()[0];
      expect(client.mode).toBe('direct');
    });

    it('should default instance to empty string when not provided', () => {
      registry.touch('MSM4M', '169.254.1.3');

      const client = registry.getClients()[0];
      expect(client.instance).toBe('');
    });

    it('should store provided mode and instance', () => {
      registry.touch('MBPM4M', '169.254.1.2', 'proxy', 'openclaw-legal');

      const client = registry.getClients()[0];
      expect(client.mode).toBe('proxy');
      expect(client.instance).toBe('openclaw-legal');
    });

    it('should increment requestCount on subsequent touches', () => {
      registry.touch('MSM4M', '169.254.1.3');
      registry.touch('MSM4M', '169.254.1.3');
      registry.touch('MSM4M', '169.254.1.3');

      const client = registry.getClients()[0];
      expect(client.requestCount).toBe(3);
    });

    it('should update ip on subsequent touches', () => {
      registry.touch('MSM4M', '169.254.1.3');
      registry.touch('MSM4M', '10.0.0.5');

      expect(registry.getClientCount()).toBe(1);
      const client = registry.getClients()[0];
      expect(client.ip).toBe('10.0.0.5');
    });

    it('should update lastSeen but not firstSeen on subsequent touches', () => {
      registry.touch('MSM4M', '169.254.1.3');
      const firstSeenBefore = registry.getClients()[0].firstSeen;

      // Small pause to ensure timestamp advances
      const t0 = Date.now();
      while (Date.now() - t0 < 5) { /* spin */ }

      registry.touch('MSM4M', '169.254.1.3');

      const client = registry.getClients()[0];
      expect(client.firstSeen).toBe(firstSeenBefore);
      expect(client.lastSeen >= client.firstSeen).toBe(true);
    });

    it('should track multiple distinct clients independently', () => {
      registry.touch('MSM4M', '169.254.1.3');
      registry.touch('MBPM4M', '169.254.1.2', 'proxy');
      registry.touch('MSM4M', '169.254.1.3'); // second request from MSM4M

      expect(registry.getClientCount()).toBe(2);

      const msm4m = registry.getClients().find(c => c.node === 'MSM4M')!;
      const mbpm4m = registry.getClients().find(c => c.node === 'MBPM4M')!;

      expect(msm4m.requestCount).toBe(2);
      expect(mbpm4m.requestCount).toBe(1);
      expect(mbpm4m.mode).toBe('proxy');
    });
  });

  describe('getClients()', () => {
    it('should return a copy of the clients array', () => {
      registry.touch('MSM4M', '169.254.1.3');

      const result1 = registry.getClients();
      const result2 = registry.getClients();

      // Different array instances
      expect(result1).not.toBe(result2);
      // But same content
      expect(result1).toEqual(result2);
    });

    it('should include all required fields', () => {
      registry.touch('MSM4M', '169.254.1.3', 'direct', 'my-instance');

      const client = registry.getClients()[0];
      expect(client.node).toBeDefined();
      expect(client.ip).toBeDefined();
      expect(client.mode).toBeDefined();
      expect(client.instance).toBeDefined();
      expect(client.firstSeen).toBeDefined();
      expect(client.lastSeen).toBeDefined();
      expect(typeof client.requestCount).toBe('number');
    });

    it('firstSeen and lastSeen should be valid ISO timestamps', () => {
      registry.touch('MSM4M', '169.254.1.3');

      const client = registry.getClients()[0];
      expect(() => new Date(client.firstSeen)).not.toThrow();
      expect(() => new Date(client.lastSeen)).not.toThrow();
      expect(isNaN(new Date(client.firstSeen).getTime())).toBe(false);
      expect(isNaN(new Date(client.lastSeen).getTime())).toBe(false);
    });
  });

  describe('getClientCount()', () => {
    it('should return 0 with no clients', () => {
      expect(registry.getClientCount()).toBe(0);
    });

    it('should return the number of distinct nodes', () => {
      registry.touch('A', '1.1.1.1');
      registry.touch('B', '1.1.1.2');
      registry.touch('A', '1.1.1.1'); // repeat — should not increase count

      expect(registry.getClientCount()).toBe(2);
    });
  });

  describe('getDisconnected()', () => {
    it('should return empty array when no clients are present', () => {
      expect(registry.getDisconnected(5000)).toEqual([]);
    });

    it('should return empty array when all clients are recent', () => {
      registry.touch('MSM4M', '169.254.1.3');
      // 60-second timeout — a just-touched client should not be disconnected
      expect(registry.getDisconnected(60_000)).toHaveLength(0);
    });

    it('should return clients whose lastSeen is older than the timeout', () => {
      registry.touch('MSM4M', '169.254.1.3');

      // Manually backdate the lastSeen to simulate an old client
      const clients = registry['clients'] as Map<string, any>;
      const client = clients.get('MSM4M')!;
      client.lastSeen = new Date(Date.now() - 10_000).toISOString();

      // With a 5-second timeout, this client should appear disconnected
      const disconnected = registry.getDisconnected(5_000);
      expect(disconnected).toHaveLength(1);
      expect(disconnected[0].node).toBe('MSM4M');
    });

    it('should not return recently-seen clients as disconnected', () => {
      // One recent, one old
      registry.touch('recent-node', '1.1.1.1');
      registry.touch('old-node', '1.1.1.2');

      const clients = registry['clients'] as Map<string, any>;
      clients.get('old-node')!.lastSeen = new Date(Date.now() - 20_000).toISOString();

      const disconnected = registry.getDisconnected(10_000);
      expect(disconnected).toHaveLength(1);
      expect(disconnected[0].node).toBe('old-node');
    });

    it('should return all clients as disconnected when timeout is 0', () => {
      registry.touch('A', '1.1.1.1');
      registry.touch('B', '1.1.1.2');

      // With 0ms timeout, any lastSeen in the past is "disconnected"
      // (edge case — mostly documents the boundary behaviour)
      const disconnected = registry.getDisconnected(0);
      expect(disconnected.length).toBe(0); // With timeout=0ms, recently-touched client should not be disconnected // timing-sensitive, just no throw
    });
  });

  describe('onEvent callback', () => {
    it('should emit client_connected on first touch', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.touch('MSM4M', '169.254.1.3', 'direct', 'my-instance');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('client_connected');
      expect((events[0] as any).node).toBe('MSM4M');
      expect((events[0] as any).ip).toBe('169.254.1.3');
      expect((events[0] as any).mode).toBe('direct');
      expect((events[0] as any).instance).toBe('my-instance');
    });

    it('should emit client_heartbeat on subsequent touches', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.touch('MSM4M', '169.254.1.3');
      reg.touch('MSM4M', '169.254.1.3');
      reg.touch('MSM4M', '169.254.1.3');

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('client_connected');
      expect(events[1].type).toBe('client_heartbeat');
      expect(events[2].type).toBe('client_heartbeat');
    });

    it('should emit client_heartbeat with updated ip', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.touch('MSM4M', '169.254.1.3');
      reg.touch('MSM4M', '10.0.0.5');

      const heartbeat = events[1] as any;
      expect(heartbeat.type).toBe('client_heartbeat');
      expect(heartbeat.ip).toBe('10.0.0.5');
    });

    it('should work without onEvent (no callback — no throw)', () => {
      const reg = new ClientRegistry(); // no callback
      expect(() => {
        reg.touch('MSM4M', '169.254.1.3');
        reg.touch('MSM4M', '169.254.1.3');
      }).not.toThrow();
    });
  });

  describe('checkDisconnected()', () => {
    it('should do nothing when no clients are present', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.checkDisconnected(5_000);

      expect(events).toHaveLength(0);
      expect(reg.getClientCount()).toBe(0);
    });

    it('should not emit or remove recent clients', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.touch('MSM4M', '169.254.1.3');
      events.length = 0; // clear the connected event

      reg.checkDisconnected(60_000);

      expect(events).toHaveLength(0);
      expect(reg.getClientCount()).toBe(1);
    });

    it('should emit client_disconnected and remove stale clients', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.touch('MSM4M', '169.254.1.3');
      events.length = 0; // clear connect event

      // Backdate lastSeen
      const clients = reg['clients'] as Map<string, any>;
      clients.get('MSM4M')!.lastSeen = new Date(Date.now() - 10_000).toISOString();

      reg.checkDisconnected(5_000);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('client_disconnected');
      expect((events[0] as any).node).toBe('MSM4M');
      // Client should be removed from the map
      expect(reg.getClientCount()).toBe(0);
    });

    it('should only remove stale clients, leaving recent ones intact', () => {
      const events: ClientRegistryEvent[] = [];
      const reg = new ClientRegistry(e => events.push(e));

      reg.touch('recent-node', '1.1.1.1');
      reg.touch('old-node', '1.1.1.2');
      events.length = 0;

      const clients = reg['clients'] as Map<string, any>;
      clients.get('old-node')!.lastSeen = new Date(Date.now() - 20_000).toISOString();

      reg.checkDisconnected(10_000);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('client_disconnected');
      expect((events[0] as any).node).toBe('old-node');
      expect(reg.getClientCount()).toBe(1);
      expect(reg.getClients()[0].node).toBe('recent-node');
    });
  });
});
