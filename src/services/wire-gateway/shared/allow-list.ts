// SPDX-License-Identifier: Apache-2.0
//
// The shared team gateway's allow list (plan Phase 16 task 1). Ported from
// magpie (MIT, Copyright (c) 2026 yetone) at e297a8ab2:
// internal/gateway/allow.go (`allowPrefixes`, `peerAddr`, `ownAddr`,
// `allowedIn`).
//
// - The address judged is the connection's own (server.requestIP). A
//   forwarding header (X-Forwarded-For and the rest) is never taken for it:
//   anyone can write one, and the gateway keeps no list of proxies to believe.
// - No list lets every address in. This computer (loopback, and the
//   computer's own interface addresses) is always let in.
// - An entry that does not read lets no address in and is logged once: the
//   list stays on, so a typo never opens the gateway to every address.

import { BlockList, isIP } from 'net';
import { networkInterfaces } from 'os';
import { logger } from '../../../utils/logger.js';
import { isLoopbackAddress } from '../network-guard.js';

/** An IPv4-mapped IPv6 address (::ffff:1.2.3.4) as the IPv4 address it carries; brackets and a zone dropped. */
export function unmapAddress(address: string): string {
  let normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith('::ffff:') && isIP(normalized.slice('::ffff:'.length)) === 4) {
    return normalized.slice('::ffff:'.length);
  }
  return normalized;
}

export interface WireAllowList {
  /** The entries as written (CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS); empty: no list. */
  readonly entries: readonly string[];
  /** Entries that did not read; each lets no address in. */
  readonly malformedEntries: readonly string[];
  readonly blockList: BlockList;
}

/** CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS: IPs and CIDR ranges, separated by commas or whitespace. */
export function splitAllowIps(setting: string): string[] {
  return setting.split(/[\s,]+/).map(entry => entry.trim()).filter(entry => entry !== '');
}

/** Adds one entry; false when it does not read as an IP or a CIDR range. */
function addAllowEntry(blockList: BlockList, entry: string): boolean {
  const slash = entry.indexOf('/');
  const address = unmapAddress(slash === -1 ? entry : entry.slice(0, slash));
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  try {
    if (slash === -1) {
      blockList.addAddress(address, type);
      return true;
    }
    const prefixText = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return false;
    // BlockList throws on a prefix past the family's width (32 / 128).
    blockList.addSubnet(address, Number(prefixText), type);
    return true;
  } catch (error) {
    logger.debug('WIRE', 'Allow-list entry did not read', { entry, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export function parseAllowList(setting: string): WireAllowList {
  const entries = splitAllowIps(setting);
  const blockList = new BlockList();
  const malformedEntries: string[] = [];
  for (const entry of entries) {
    if (!addAllowEntry(blockList, entry)) {
      malformedEntries.push(entry);
      logger.warn('WIRE', 'CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS has an entry that is not an IP or CIDR range; it lets no address in', { entry });
    }
  }
  return { entries, malformedEntries, blockList };
}

/** This computer's own interface addresses (magpie `ownAddr`): a connection comes from one only when it was made here. */
export function isOwnInterfaceAddress(address: string): boolean {
  const wanted = unmapAddress(address);
  for (const interfaceAddresses of Object.values(networkInterfaces())) {
    for (const interfaceAddress of interfaceAddresses ?? []) {
      if (unmapAddress(interfaceAddress.address) === wanted) return true;
    }
  }
  return false;
}

/**
 * Whether a connection from `peerAddress` may reach the gateway at all
 * (magpie `allowedIn`): there is no list, it is loopback or this computer's
 * own address, or the list holds it. An unknown peer (the socket is gone, or
 * the address does not read) is never let in by a list.
 */
export function isAllowedByList(allowList: WireAllowList, peerAddress: string | null): boolean {
  if (allowList.entries.length === 0) return true;
  if (!peerAddress) return false;
  const address = unmapAddress(peerAddress);
  const family = isIP(address);
  if (family === 0) return false;
  if (isLoopbackAddress(address)) return true;
  if (allowList.blockList.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  return isOwnInterfaceAddress(address);
}
