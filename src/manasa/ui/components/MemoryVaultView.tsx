// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import type { KnowledgeGraphData, RecalledMemory } from '../../types.js';
import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas.js';

interface Props {
  memories: RecalledMemory[];
  graph: KnowledgeGraphData;
  onSearchMemories: (kind: string, query: string) => void;
  onAddExplicitMemory: (factText: string) => Promise<void>;
  onReinforceMemory: (id: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  onTriggerSleep: () => Promise<void>;
  sleeping: boolean;
}

export function MemoryVaultView({
  memories,
  graph,
  onSearchMemories,
  onAddExplicitMemory,
  onReinforceMemory,
  onDeleteMemory,
  onTriggerSleep,
  sleeping,
}: Props) {
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [newFact, setNewFact] = useState('');
  const [saving, setSaving] = useState(false);

  const handleFilterChange = (nextKind: string) => {
    setKindFilter(nextKind);
    onSearchMemories(nextKind, query);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearchMemories(kindFilter, query);
  };

  const handleCreateFact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFact.trim()) return;
    setSaving(true);
    try {
      await onAddExplicitMemory(newFact.trim());
      setNewFact('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="vault-split">
      {/* Left: Force-Directed Synaptic Knowledge Graph */}
      <div className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
              🕸️ Living Hippocampal Knowledge Graph (claude-mem)
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: '#94a3b8' }}>
              Drag nodes to explore • Synaptic edges pulse with ACT-R power-law activation strength
            </p>
          </div>
          <button className="sleep-btn" style={{ width: 'auto' }} onClick={onTriggerSleep} disabled={sleeping}>
            {sleeping ? '🌙 Consolidating...' : '🌙 Run REM Consolidation'}
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
          }}
        >
          {[
            { label: 'Total Memories', val: graph.stats.totalMemories, color: '#06b6d4' },
            { label: 'Semantic Facts', val: graph.stats.manualFacts, color: '#10b981' },
            { label: 'Concept Hubs', val: graph.stats.conceptCount, color: '#a855f7' },
            { label: 'Avg ACT-R Score', val: graph.stats.avgActRStrength, color: '#f59e0b' },
          ].map(stat => (
            <div
              key={stat.label}
              style={{
                background: 'rgba(7, 11, 21, 0.82)',
                border: '1px solid rgba(148, 163, 184, 0.14)',
                borderRadius: 10,
                padding: '9px 11px',
              }}
            >
              <div style={{ fontSize: '0.69rem', color: '#94a3b8' }}>{stat.label}</div>
              <div style={{ fontSize: '1.12rem', fontWeight: 800, color: stat.color }}>{stat.val}</div>
            </div>
          ))}
        </div>

        <KnowledgeGraphCanvas graph={graph} />
      </div>

      {/* Right: SQLite FTS5 + ACT-R Memory Vault Explorer */}
      <div className="glass-panel" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 'calc(100vh - 125px)', overflow: 'hidden' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>🗄️ claude-mem Persistent Vault (SQLite FTS5 + ACT-R)</h2>
          <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: '#94a3b8' }}>
            Every fact & episode is persisted in SQLite and ranked by Anderson & Schooler power-law decay
          </p>
        </div>

        <form onSubmit={handleCreateFact} style={{ display: 'flex', gap: 8 }}>
          <input
            className="text-input"
            style={{ flex: 1 }}
            placeholder='Add memory directly (e.g. "Mage goal eka AI product ekak launch karana eka")'
            value={newFact}
            onChange={e => setNewFact(e.target.value)}
          />
          <button type="submit" className="primary-action-btn" disabled={saving || !newFact.trim()}>
            {saving ? 'Saving...' : '+ Encode Fact'}
          </button>
        </form>

        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="text-input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="Search FTS5 + TF-IDF cosine memories..."
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) onSearchMemories(kindFilter, '');
            }}
          />
          <button type="submit" className="control-pill active">
            🔍 Search
          </button>
        </form>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'all', label: 'All Traces' },
            { id: 'manual', label: 'Semantic Facts' },
            { id: 'observation', label: 'Episodic' },
            { id: 'summary', label: 'REM Summaries' },
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`control-pill ${kindFilter === tab.id ? 'active' : ''}`}
              onClick={() => handleFilterChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9, paddingRight: 4 }}>
          {memories.length === 0 ? (
            <div style={{ color: '#94a3b8', fontSize: '0.85rem', padding: 20, textAlign: 'center' }}>
              No matching memory traces found. Try teaching MANASA-1 something in chat!
            </div>
          ) : (
            memories.map(mem => (
              <div className="memory-card" key={mem.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <span
                      className="badge-pill"
                      style={{
                        background:
                          mem.kind === 'manual'
                            ? 'rgba(16, 185, 129, 0.16)'
                            : mem.kind === 'summary'
                              ? 'rgba(236, 72, 153, 0.16)'
                              : 'rgba(59, 130, 246, 0.16)',
                        color:
                          mem.kind === 'manual'
                            ? '#34d399'
                            : mem.kind === 'summary'
                              ? '#f472b6'
                              : '#60a5fa',
                      }}
                    >
                      {mem.kind}
                    </span>
                    <strong style={{ fontSize: '0.86rem' }}>{mem.title}</strong>
                  </div>
                  <span style={{ fontSize: '0.73rem', fontWeight: 700, color: '#fbbf24', flexShrink: 0 }}>
                    ACT-R: {mem.actRScore}
                  </span>
                </div>

                <div style={{ fontSize: '0.8rem', color: '#cbd5e1' }}>{mem.text}</div>

                {mem.concepts.length > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {mem.concepts.map(c => (
                      <span
                        key={c}
                        style={{
                          fontSize: '0.68rem',
                          padding: '1px 7px',
                          borderRadius: 999,
                          background: 'rgba(168, 85, 247, 0.14)',
                          color: '#d8b4fe',
                        }}
                      >
                        #{c}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 3 }}>
                  <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                    Reinforced {mem.reinforcementDates.length}× • {new Date(mem.updatedAtEpoch).toLocaleTimeString()}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="mini-action-btn"
                      onClick={() => onReinforceMemory(mem.id)}
                      title="Strengthen synapse via ACT-R spacing reinforcement"
                    >
                      ⚡ +ACT-R Boost
                    </button>
                    {!mem.title.startsWith('Core Identity') && (
                      <button
                        type="button"
                        className="mini-action-btn"
                        onClick={() => onDeleteMemory(mem.id)}
                        title="Forget this memory trace"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
