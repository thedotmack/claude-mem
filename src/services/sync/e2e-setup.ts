// SPDX-License-Identifier: Apache-2.0
//
// Turns CLAUDE_MEM_CLOUD_SYNC_E2E + <data dir>/sync-e2e.key (or the
// CLAUDE_MEM_CLOUD_SYNC_E2E_KEY environment variable) into the process-wide
// codec used by CanonicalContent. Returns false when E2E is required but the
// key is missing or unreadable: the caller must then not start sync at all.

import { logger } from '../../utils/logger.js';
import { configureSyncE2E } from './CanonicalContent.js';
import { decodeE2EKey, E2ECodec, e2eKeyPath, readE2EKey } from './E2ECodec.js';

export function configureSyncE2EFromSettings(
  settings: { CLAUDE_MEM_CLOUD_SYNC_E2E?: string },
  keyPath = e2eKeyPath(),
): boolean {
  configureSyncE2E(null);
  // A key in the environment (e.g. a Claude Code cloud environment variable,
  // which setup scripts cannot see) turns E2E on by itself: a device that holds
  // the key must never push plaintext.
  const envKey = (process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY ?? '').trim();
  if ((settings.CLAUDE_MEM_CLOUD_SYNC_E2E ?? '').trim().toLowerCase() !== 'true' && !envKey) return true;
  try {
    const key = readE2EKey(keyPath) ?? (envKey ? decodeE2EKey(envKey) : null);
    if (!key) {
      logger.error('CLOUD_SYNC', 'End-to-end encryption is on but the key file is missing; sync stays off', { keyPath });
      return false;
    }
    const codec = new E2ECodec(key);
    configureSyncE2E(codec);
    logger.info('CLOUD_SYNC', 'End-to-end encryption enabled', { keyId: codec.keyId });
    return true;
  } catch (error) {
    logger.error('CLOUD_SYNC', 'End-to-end encryption key is unreadable; sync stays off', { keyPath }, error as Error);
    return false;
  }
}
