/**
 * ClientRegistry — In-memory tracking of connected client machines
 *
 * Volatile: NOT persisted to DB. State is reconstructed from incoming requests.
 * Each request carrying x-claude-mem-node header calls touch() to update the map.
 */

export interface ClientInfo {
  node: string;
  ip: string;
  mode: string;       // 'proxy' | 'direct'
  instance: string;   // empty string when not set
  firstSeen: string;  // ISO timestamp
  lastSeen: string;   // ISO timestamp
  requestCount: number;
}

export type ClientRegistryEvent =
  | { type: 'client_connected'; node: string; ip: string; mode: string; instance: string }
  | { type: 'client_heartbeat'; node: string; ip: string }
  | { type: 'client_disconnected'; node: string; ip: string };

export type ClientRegistryEventHandler = (event: ClientRegistryEvent) => void;

export class ClientRegistry {
  private clients = new Map<string, ClientInfo>();
  private onEvent?: ClientRegistryEventHandler;

  constructor(onEvent?: ClientRegistryEventHandler) {
    this.onEvent = onEvent;
  }

  /**
   * Record or update a client's presence.
   * @param node      - Value of x-claude-mem-node header
   * @param ip        - Remote IP address from req.ip
   * @param mode      - Value of x-claude-mem-mode header (defaults to 'direct')
   * @param instance  - Value of x-claude-mem-instance header (defaults to '')
   */
  touch(node: string, ip: string, mode?: string, instance?: string): void {
    const now = new Date().toISOString();
    const existing = this.clients.get(node);

    if (existing) {
      existing.ip = ip;
      existing.mode = mode ?? existing.mode;
      existing.instance = instance ?? existing.instance;
      existing.lastSeen = now;
      existing.requestCount += 1;
      this.onEvent?.({ type: 'client_heartbeat', node, ip });
    } else {
      const resolvedMode = mode ?? 'direct';
      const resolvedInstance = instance ?? '';
      this.clients.set(node, {
        node,
        ip,
        mode: resolvedMode,
        instance: resolvedInstance,
        firstSeen: now,
        lastSeen: now,
        requestCount: 1,
      });
      this.onEvent?.({ type: 'client_connected', node, ip, mode: resolvedMode, instance: resolvedInstance });
    }
  }

  /**
   * Check for clients that have not been seen in `timeoutMs` milliseconds,
   * emit `client_disconnected` for each, and remove them from the map.
   */
  checkDisconnected(timeoutMs: number): void {
    const cutoff = Date.now() - timeoutMs;
    for (const [key, client] of this.clients) {
      if (new Date(client.lastSeen).getTime() < cutoff) {
        this.onEvent?.({ type: 'client_disconnected', node: client.node, ip: client.ip });
        this.clients.delete(key);
      }
    }
  }

  /**
   * Return all tracked clients as an array.
   */
  getClients(): ClientInfo[] {
    return Array.from(this.clients.values());
  }

  /**
   * Return the number of distinct clients seen.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Return clients whose lastSeen is older than `timeoutMs` milliseconds ago.
   */
  getDisconnected(timeoutMs: number): ClientInfo[] {
    const cutoff = Date.now() - timeoutMs;
    return Array.from(this.clients.values()).filter(c =>
      new Date(c.lastSeen).getTime() < cutoff
    );
  }
}

/** Singleton instance shared across the process */
export const clientRegistry = new ClientRegistry();
