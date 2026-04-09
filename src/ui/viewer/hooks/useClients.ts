import { useState, useEffect, useCallback, useRef } from 'react';
import { ClientInfo, TrackedClient } from '../types';
import { API_ENDPOINTS } from '../constants/api';
import type { ClientSSEEvent } from './useSSE';

/** Clients seen within this window are considered active */
const ACTIVE_THRESHOLD_MS = 60_000; // 60 seconds

function isActive(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < ACTIVE_THRESHOLD_MS;
}

/**
 * Merge a ClientInfo array into the tracked map.
 * Existing entries are updated; new ones are added.
 * Entries never removed — they go inactive instead.
 */
/** Composite key matching ClientRegistry's node\0instance strategy, using | as the viewer-safe delimiter. */
function clientKey(node: string, instance: string): string {
  return `${node}|${instance}`;
}

function mergeClients(
  current: Map<string, TrackedClient>,
  incoming: ClientInfo[]
): Map<string, TrackedClient> {
  const next = new Map(current);
  for (const c of incoming) {
    const key = clientKey(c.node, c.instance);
    const existing = next.get(key);
    if (existing) {
      // Update with latest data, keep whichever firstSeen is earlier
      next.set(key, {
        ...existing,
        ...c,
        firstSeen: existing.firstSeen < c.firstSeen ? existing.firstSeen : c.firstSeen,
        active: isActive(c.lastSeen),
      });
    } else {
      next.set(key, { ...c, active: isActive(c.lastSeen) });
    }
  }
  return next;
}

export function useClients(mode?: string) {
  const [clientMap, setClientMap] = useState<Map<string, TrackedClient>>(new Map());
  const sseHandlerRegistered = useRef(false);

  const loadClients = useCallback(async () => {
    if (mode !== 'server') {
      setClientMap(new Map());
      return;
    }

    try {
      const response = await fetch(API_ENDPOINTS.CLIENTS);
      if (!response.ok) {
        console.error('Failed to load clients:', response.status);
        return;
      }
      const data = await response.json();
      const incoming: ClientInfo[] = data.clients || [];
      setClientMap(prev => mergeClients(prev, incoming));
    } catch (error) {
      console.error('Failed to load clients:', error);
    }
  }, [mode]);

  /** Handle a single SSE client event */
  const handleClientSSE = useCallback((event: ClientSSEEvent) => {
    const now = new Date().toISOString();
    setClientMap(prev => {
      const next = new Map(prev);
      const nodeName = event.node || '';
      const instanceName = event.instance || '';
      const key = clientKey(nodeName, instanceName);
      const existing = next.get(key);

      switch (event.type) {
        case 'client_connected': {
          if (existing) {
            next.set(key, {
              ...existing,
              ip: event.ip || existing.ip,
              mode: event.mode || existing.mode,
              instance: instanceName || existing.instance,
              lastSeen: now,
              requestCount: existing.requestCount + 1,
              active: true,
            });
          } else {
            next.set(key, {
              node: nodeName,
              ip: event.ip || '',
              mode: event.mode || 'direct',
              instance: instanceName,
              firstSeen: now,
              lastSeen: now,
              requestCount: 1,
              active: true,
            });
          }
          break;
        }
        case 'client_heartbeat': {
          if (existing) {
            next.set(key, {
              ...existing,
              lastSeen: now,
              requestCount: existing.requestCount + 1,
              active: true,
            });
          }
          break;
        }
        case 'client_disconnected': {
          if (existing) {
            next.set(key, {
              ...existing,
              active: false,
            });
          }
          break;
        }
      }

      return next;
    });
  }, []);

  // Periodic refresh of active/inactive state based on lastSeen
  useEffect(() => {
    if (mode !== 'server') return;

    const interval = setInterval(() => {
      setClientMap(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, client] of next) {
          const shouldBeActive = isActive(client.lastSeen);
          if (client.active !== shouldBeActive) {
            next.set(key, { ...client, active: shouldBeActive });
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 10_000); // Check every 10s

    return () => clearInterval(interval);
  }, [mode]);

  // Initial load + polling
  useEffect(() => {
    loadClients();

    if (mode === 'server') {
      const interval = setInterval(loadClients, 15_000);
      return () => clearInterval(interval);
    }
  }, [loadClients, mode]);

  // Convert map to sorted array
  const clients: TrackedClient[] = Array.from(clientMap.values())
    .sort((a, b) => {
      // Active first, then alphabetical
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.node.localeCompare(b.node);
    });

  const activeCount = clients.filter(c => c.active).length;

  return {
    clients,
    activeCount,
    totalCount: clients.length,
    refreshClients: loadClients,
    handleClientSSE,
    sseHandlerRegistered,
  };
}
