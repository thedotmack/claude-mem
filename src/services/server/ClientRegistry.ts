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

export class ClientRegistry {
  private clients = new Map<string, ClientInfo>();

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
    } else {
      this.clients.set(node, {
        node,
        ip,
        mode: mode ?? 'direct',
        instance: instance ?? '',
        firstSeen: now,
        lastSeen: now,
        requestCount: 1,
      });
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
