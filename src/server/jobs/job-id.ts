// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { SERVER_JOB_KIND_PREFIX, type ServerGenerationJobKind } from './types.js';

export interface ServerJobIdParts {
  kind: ServerGenerationJobKind;
  team_id: string;
  project_id: string;
  source_type: string;
  source_id: string;
}

// SHA-256-derived deterministic IDs avoid Redis key collisions across tenants
// and keep BullMQ jobId deduplication intact across process restarts.
// Format: `${kindPrefix}_${sha256hex}` with NO ':' characters (BullMQ uses ':'
// internally as a key separator; embedding ':' in jobIds causes scan/state
// confusion).
export function buildServerJobId(parts: ServerJobIdParts): string {
  const prefix = SERVER_JOB_KIND_PREFIX[parts.kind];
  const canonical = JSON.stringify({
    kind: parts.kind,
    team_id: parts.team_id,
    project_id: parts.project_id,
    source_type: parts.source_type,
    source_id: parts.source_id
  });
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `${prefix}_${digest}`;
}
