// SPDX-License-Identifier: Apache-2.0
//
// Capture on a shared team gateway (plan D15, Phase 16 tasks 3–4).
//
// - A session is captured only when the client named it (header, body,
//   launch or x-claude-mem-session). A fingerprint (`wire-<hash>` of the
//   user's first words) is a guess: two members who start with the same words
//   would share one, so it is never recorded or captured in shared mode.
// - A keyed request's session ids are namespaced by its key's name and record
//   id (`key:<name>/<record id>:<id>`), so two members who name the same session never share
//   the assembler's, turn tracker's or ledger's state. The namespace also
//   tells the event sink where an event goes: to that key's server runtime
//   through the outbox, with the member's own session id restored, and only
//   while that same record holds the name (a key removed and added again for
//   someone else never receives the first member's events). A session
//   with no key (an agent on the gateway host itself) goes to this host's
//   worker through the hook spool, as on a single-user gateway.

import { logger } from '../../../utils/logger.js';
import type { HookSpoolKind, HookSpoolPayloadByKind } from '../../../shared/hook-spool.js';
import type { WireCaptureEventSink } from '../capture/capture-event-sink.js';
import type { WireIdentity } from '../identity/resolve-identity.js';
import { scrubWireSpoolPayload } from '../privacy/secret-scrub.js';
import type { WireClientKeyIdentity, WireClientKeyLookup } from './client-keys.js';
import type { WireServerOutbox } from './server-outbox.js';

const CLIENT_KEY_SESSION_PREFIX = 'key:';

/** A keyed request's session (and parent session) ids, namespaced by the key's name and record id. */
export function identityForClientKey(identity: WireIdentity, clientKey: Pick<WireClientKeyIdentity, 'name' | 'keyId'>): WireIdentity {
  const namespaced = (sessionId: string) => `${CLIENT_KEY_SESSION_PREFIX}${clientKey.name}/${clientKey.keyId}:${sessionId}`;
  return {
    ...identity,
    sessionId: namespaced(identity.sessionId),
    ...(identity.parentSessionId !== undefined ? { parentSessionId: namespaced(identity.parentSessionId) } : {}),
  };
}

/** The key name, record id and the member's own session id of a namespaced id; null for a session with no key. */
export function splitClientKeySessionId(contentSessionId: string): { keyName: string; keyId: string; sessionId: string } | null {
  if (!contentSessionId.startsWith(CLIENT_KEY_SESSION_PREFIX)) return null;
  const rest = contentSessionId.slice(CLIENT_KEY_SESSION_PREFIX.length);
  const separator = rest.indexOf(':');
  const slash = rest.indexOf('/');
  if (separator <= 0 || slash <= 0 || slash > separator) return null;
  return { keyName: rest.slice(0, slash), keyId: rest.slice(slash + 1, separator), sessionId: rest.slice(separator + 1) };
}

/** Shared mode's capture rule: only sessions the client named. */
export function isSessionCapturableInSharedMode(identity: Pick<WireIdentity, 'sessionSource'>): boolean {
  return identity.sessionSource !== 'fingerprint';
}

export interface SharedModeCaptureEventSinkOptions {
  /** Where sessions with no key go: this host's worker, through the hook spool. */
  localSink: WireCaptureEventSink;
  outbox: WireServerOutbox;
  lookupKey: (keyName: string) => WireClientKeyLookup;
}

/** Never throws and never waits on a server: the outbox write is local and durable. */
export function createSharedModeCaptureEventSink(options: SharedModeCaptureEventSinkOptions): WireCaptureEventSink {
  return {
    emit<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]) {
      const keyed = splitClientKeySessionId(payload.contentSessionId);
      if (!keyed) {
        options.localSink.emit(kind, payload);
        return;
      }
      const lookup = options.lookupKey(keyed.keyName);
      if (lookup.kind !== 'found' || lookup.identity.keyId !== keyed.keyId) {
        logger.error('WIRE', lookup.kind === 'unreadable'
          ? 'A captured event cannot be queued: keys.json cannot be read; it is lost'
          : 'A captured event belongs to a client key no longer in keys.json; it is lost', { kind, client: keyed.keyName });
        return;
      }
      const identity = lookup.identity;
      const memberPayload = scrubWireSpoolPayload(kind, { ...payload, contentSessionId: keyed.sessionId });
      try {
        options.outbox.enqueue(identity, kind, memberPayload);
      } catch (error) {
        // OutboxFullError included: the key's pending/ is at its limit (server-outbox.ts).
        logger.error('WIRE', 'A captured event could not be written to the outbox; it is lost', { kind, client: keyed.keyName },
          error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
