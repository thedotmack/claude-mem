/**
 * Agent Coordination Types
 *
 * TypeScript interfaces for the coordination system that enables
 * multi-agent file claiming, discovery sharing, and conflict detection.
 */

// ── Claim Types ──────────────────────────────────────────────────────

export type ClaimScope = 'read' | 'write';

export interface ClaimInput {
  agent_id: string;
  agent_name: string;
  files: string[];
  scope: ClaimScope;
  intent?: string;
  session_id?: string;
  ttl_minutes: number;
}

export interface ClaimRecord {
  id: number;
  agent_id: string;
  agent_name: string;
  file_path: string;
  scope: ClaimScope;
  intent: string | null;
  session_id: string | null;
  claimed_at_epoch: number;
  expires_at_epoch: number;
  released_at_epoch: number | null;
}

export interface ClaimResult {
  claim_ids: number[];
  conflicts: ConflictRecord[];
}

export interface ReleaseResult {
  released_count: number;
}

// ── Discovery Types ──────────────────────────────────────────────────

export type DiscoveryType = 'finding' | 'warning' | 'dependency' | 'conflict' | 'recommendation';
export type Severity = 'info' | 'warning' | 'critical';

export interface DiscoveryInput {
  agent_id: string;
  agent_name: string;
  discovery_type: DiscoveryType;
  content: string;
  affected_files?: string[];
  severity?: Severity;
  session_id?: string;
}

export interface DiscoveryRecord {
  id: number;
  agent_id: string;
  agent_name: string;
  discovery_type: DiscoveryType;
  content: string;
  affected_files: string | null; // JSON array
  severity: Severity;
  session_id: string | null;
  created_at_epoch: number;
}

export interface DiscoveryQuery {
  session_id?: string;
  agent_id?: string;
  affected_file?: string;
  since_epoch?: number;
  limit?: number;
}

// ── Conflict Types ───────────────────────────────────────────────────

export type ConflictType = 'write_write' | 'read_write';
export type ConflictResolution = 'unresolved' | 'agent_a_priority' | 'agent_b_priority' | 'merged' | 'dismissed';

export interface ConflictRecord {
  id: number;
  claim_a_id: number;
  claim_b_id: number;
  agent_a_id: string;
  agent_b_id: string;
  conflict_type: ConflictType;
  files: string; // JSON array
  description: string | null;
  resolution: ConflictResolution;
  resolved_at_epoch: number | null;
  session_id: string | null;
  created_at_epoch: number;
}

// ── Check Conflicts Types ────────────────────────────────────────────

export interface FileConflictCheck {
  file_path: string;
  has_conflict: boolean;
  claims: ClaimRecord[];
}

export interface CheckConflictsResult {
  conflicts: FileConflictCheck[];
}
