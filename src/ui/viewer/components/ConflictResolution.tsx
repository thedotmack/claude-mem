import React, { useMemo } from 'react';
import { Observation, FileLock, AgentControls } from '../types';

interface ConflictResolutionProps {
  observations: Observation[];
  locks: FileLock[];
  controls: AgentControls | null;
}

interface Conflict {
  id: string;
  type: 'lock_contention' | 'decision_conflict' | 'stale_lock';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  agents: string[];
  timestamp: number;
  data: any;
}

function detectConflicts(observations: Observation[], locks: FileLock[], controls: AgentControls | null): Conflict[] {
  const conflicts: Conflict[] = [];
  const now = Date.now();

  // Detect stale locks (> 8 minutes old out of 10 minute TTL)
  for (const lock of locks) {
    const ageMs = now - lock.locked_at_epoch;
    if (ageMs > 8 * 60 * 1000) {
      conflicts.push({
        id: `stale-lock-${lock.id}`,
        type: 'stale_lock',
        severity: ageMs > 9.5 * 60 * 1000 ? 'high' : 'medium',
        title: `Stale lock on ${lock.file_path}`,
        description: `Locked by ${lock.locked_by} ${Math.round(ageMs / 60000)} minutes ago. Lock expires soon.`,
        agents: [lock.locked_by],
        timestamp: lock.locked_at_epoch,
        data: lock,
      });
    }
  }

  // Detect decision conflicts (multiple agents writing decisions on same topic)
  const decisions = observations.filter(o => o.type === 'decision');
  const decisionsByTitle: Record<string, Observation[]> = {};
  for (const d of decisions) {
    const key = (d.title || '').toLowerCase().trim();
    if (!decisionsByTitle[key]) decisionsByTitle[key] = [];
    decisionsByTitle[key].push(d);
  }
  for (const [title, decs] of Object.entries(decisionsByTitle)) {
    if (decs.length > 1) {
      const agents = [...new Set(decs.map(d => d.project))];
      if (agents.length > 1) {
        conflicts.push({
          id: `decision-conflict-${title}`,
          type: 'decision_conflict',
          severity: 'high',
          title: `Conflicting decisions: "${decs[0].title}"`,
          description: `${agents.join(' and ')} made different decisions on the same topic.`,
          agents,
          timestamp: Math.max(...decs.map(d => d.created_at_epoch)),
          data: decs,
        });
      }
    }
  }

  // Detect lock contention (multiple agents trying to lock same file recently)
  const lockPaths: Record<string, string[]> = {};
  for (const lock of locks) {
    if (!lockPaths[lock.file_path]) lockPaths[lock.file_path] = [];
    lockPaths[lock.file_path].push(lock.locked_by);
  }
  for (const [path, agents] of Object.entries(lockPaths)) {
    if (agents.length > 1) {
      conflicts.push({
        id: `lock-contention-${path}`,
        type: 'lock_contention',
        severity: 'high',
        title: `Lock contention on ${path}`,
        description: `Multiple agents want to edit: ${agents.join(', ')}`,
        agents,
        timestamp: now,
        data: { path, agents },
      });
    }
  }

  conflicts.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  return conflicts;
}

function ConflictCard({ conflict }: { conflict: Conflict }) {
  const severityColor = conflict.severity === 'high' ? 'var(--color-accent-error)' :
    conflict.severity === 'medium' ? 'var(--color-accent-summary)' : 'var(--color-text-muted)';

  return (
    <div className="collab-conflict-card">
      <div className="collab-conflict-header">
        <span className="collab-conflict-severity" style={{ color: severityColor }}>
          {conflict.severity === 'high' ? '!!!' : conflict.severity === 'medium' ? '!!' : '!'}
        </span>
        <span className={`collab-badge collab-badge-${conflict.type}`}>
          {conflict.type.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="collab-conflict-title">{conflict.title}</div>
      <div className="collab-conflict-description">{conflict.description}</div>
      <div className="collab-conflict-agents">
        {conflict.agents.map(a => (
          <span key={a} className="collab-conflict-agent-tag">{a}</span>
        ))}
      </div>
    </div>
  );
}

export function ConflictResolution({ observations, locks, controls }: ConflictResolutionProps) {
  const conflicts = useMemo(
    () => detectConflicts(observations, locks, controls),
    [observations, locks, controls]
  );

  const leader = controls?.leader || 'unknown';
  const leaderMode = controls?.leader_mode || 'auto';

  return (
    <div className="collab-conflicts">
      <div className="collab-section">
        <div className="collab-conflicts-summary">
          <div className="collab-stat-card">
            <div className="collab-stat-value" style={{ color: conflicts.length > 0 ? 'var(--color-accent-error)' : 'var(--color-accent-success)' }}>
              {conflicts.length}
            </div>
            <div className="collab-stat-label">Active Conflicts</div>
          </div>
          <div className="collab-stat-card">
            <div className="collab-stat-value">{leader}</div>
            <div className="collab-stat-label">Resolution Authority</div>
          </div>
          <div className="collab-stat-card">
            <div className="collab-stat-value">{leaderMode}</div>
            <div className="collab-stat-label">Leader Mode</div>
          </div>
        </div>
      </div>

      {conflicts.length === 0 ? (
        <div className="collab-empty" style={{ padding: '40px 20px' }}>
          No conflicts detected. All agents are working harmoniously.
        </div>
      ) : (
        <div className="collab-section">
          <h2 className="collab-section-title">Detected Conflicts</h2>
          <div className="collab-conflicts-list">
            {conflicts.map(c => <ConflictCard key={c.id} conflict={c} />)}
          </div>
        </div>
      )}
    </div>
  );
}
