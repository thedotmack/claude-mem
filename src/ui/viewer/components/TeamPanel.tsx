import React, { useState, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';

interface AgentConfig {
  listening: boolean;
  polling_interval?: number;
  model: string;
  reasoning: string;
  permissions: string;
  last_heartbeat?: number;
  status?: string;
  current_task?: string;
  tokens_used_today?: number;
  context_window_pct?: number;
}

interface TeamPanelProps {
  controls: {
    leader: string;
    agents: Record<string, AgentConfig>;
    active_project?: string;
  } | null;
  onRefresh: () => void;
}

const MODEL_OPTIONS = [
  { group: 'Claude', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  { group: 'OpenAI', models: ['gpt-5.4', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3-mini', 'o3', 'o4-mini'] },
  { group: 'Gemini', models: ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'] },
  { group: 'Open Source', models: ['deepseek-v3.2', 'llama-4-scout', 'llama-4-maverick', 'qwen-3-235b'] },
  { group: 'OpenRouter (free)', models: ['xiaomi/mimo-v2-flash:free', 'stepfun/step-3.5-flash:free', 'deepseek/deepseek-chat-v3-0324:free'] },
];

const REASONING_OPTIONS = ['standard', 'extended', 'minimal'];
const PERMISSION_OPTIONS = ['full', 'sandboxed', 'read-plan', 'supervised', 'off'];

export function TeamPanel({ controls, onRefresh }: TeamPanelProps) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [customModelAgents, setCustomModelAgents] = useState<Set<string>>(new Set());
  const [customModelValues, setCustomModelValues] = useState<Record<string, string>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});

  const updateAgent = useCallback(async (agent: string, patch: Partial<AgentConfig>) => {
    setUpdating(agent);
    setUpdateErrors(prev => { const p = { ...prev }; delete p[agent]; return p; });
    try {
      const res = await fetch(`${API_ENDPOINTS.CONTROLS}/${agent}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        const errText = await res.text();
        setUpdateErrors(prev => ({ ...prev, [agent]: `Failed (${res.status}): ${errText}` }));
      } else {
        // Show brief success for model changes
        if (patch.model) {
          setUpdateErrors(prev => ({ ...prev, [agent]: `Model set to: ${patch.model}` }));
          setTimeout(() => setUpdateErrors(prev => { const p = { ...prev }; delete p[agent]; return p; }), 3000);
        }
      }
      onRefresh();
    } catch (err: any) {
      setUpdateErrors(prev => ({ ...prev, [agent]: `Error: ${err.message}` }));
    }
    setUpdating(null);
  }, [onRefresh]);

  const setLeader = useCallback(async (agent: string) => {
    try {
      await fetch(API_ENDPOINTS.CONTROLS, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leader: agent })
      });
      onRefresh();
    } catch (err) {
      console.error('Failed to set leader:', err);
    }
  }, [onRefresh]);

  const addAgent = useCallback(async () => {
    if (!newAgentName.trim()) return;
    const name = newAgentName.trim().toLowerCase().replace(/\s+/g, '-');
    await updateAgent(name, { listening: true, model: 'gpt-4o-mini', reasoning: 'standard', permissions: 'sandboxed' });
    setNewAgentName('');
    setShowAddAgent(false);
  }, [newAgentName, updateAgent]);

  if (!controls) {
    return <div style={{ padding: '20px', color: 'var(--text-secondary, #888)' }}>Loading team data...</div>;
  }

  const agents = Object.entries(controls.agents || {});

  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, color: 'var(--text-primary, #e0e0e0)', fontSize: '16px' }}>
          Team ({agents.length} agents)
        </h3>
        <button onClick={() => setShowAddAgent(!showAddAgent)}
          style={{ background: 'var(--accent-color, #7c3aed)', color: '#fff', border: 'none',
            borderRadius: '6px', padding: '5px 14px', fontSize: '12px', cursor: 'pointer' }}>
          + Add Agent
        </button>
      </div>

      {showAddAgent && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', padding: '12px',
          background: 'var(--bg-secondary, #16213e)', borderRadius: '8px', border: '1px solid var(--border-color, #333)' }}>
          <input type="text" value={newAgentName} onChange={(e) => setNewAgentName(e.target.value)}
            placeholder="Agent name (e.g. reviewer)"
            style={{ flex: 1, background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)',
              border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '6px 10px', fontSize: '13px' }}
            onKeyDown={(e) => e.key === 'Enter' && addAgent()} />
          <button onClick={addAgent} style={{ background: '#4ade80', color: '#000', border: 'none',
            borderRadius: '4px', padding: '6px 14px', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>Create</button>
          <button onClick={() => setShowAddAgent(false)} style={{ background: 'transparent', color: 'var(--text-secondary, #888)',
            border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '6px 10px', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {agents.map(([name, config]) => {
          const isLeader = controls.leader === name;
          const isOnline = config.last_heartbeat && (Date.now() - config.last_heartbeat < 120000);
          const isUpdating = updating === name;

          return (
            <div key={name} style={{
              background: 'var(--bg-secondary, #16213e)',
              border: `1px solid ${isLeader ? 'var(--accent-color, #7c3aed)' : 'var(--border-color, #333)'}`,
              borderRadius: '10px', padding: '16px', opacity: isUpdating ? 0.6 : 1, transition: 'all 0.15s ease'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%',
                    background: config.listening ? (isOnline ? '#4ade80' : '#facc15') : '#666', display: 'inline-block' }} />
                  <span style={{ fontWeight: 600, color: 'var(--text-primary, #e0e0e0)', fontSize: '15px' }}>{name}</span>
                  {isLeader && (
                    <span style={{ background: 'var(--accent-color, #7c3aed)', color: '#fff', fontSize: '10px',
                      padding: '2px 6px', borderRadius: '3px', fontWeight: 600 }}>LEADER</span>
                  )}
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '11px', color: 'var(--text-secondary, #888)' }}>
                  <input type="checkbox" checked={config.listening}
                    onChange={(e) => updateAgent(name, { listening: e.target.checked })} style={{ cursor: 'pointer' }} />
                  Active
                </label>
              </div>

              {/* Model selector */}
              <div style={{ marginBottom: '8px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', display: 'block', marginBottom: '4px' }}>Model</label>
                {customModelAgents.has(name) || !MODEL_OPTIONS.some(g => g.models.includes(config.model)) ? (
                  <div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <input type="text" value={customModelValues[name] ?? config.model}
                        onChange={(e) => setCustomModelValues(prev => ({ ...prev, [name]: e.target.value }))}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val && val !== config.model) updateAgent(name, { model: val });
                          if (!val) setCustomModelAgents(prev => { const s = new Set(prev); s.delete(name); return s; });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val) { updateAgent(name, { model: val }); setCustomModelValues(prev => { const p = { ...prev }; delete p[name]; return p; }); }
                          }
                        }}
                        placeholder="e.g. openai/gpt-4o or deepseek/deepseek-v3" autoFocus
                        style={{ flex: 1, background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)',
                          border: '1px solid var(--accent-color, #7c3aed)', borderRadius: '4px', padding: '5px 8px', fontSize: '12px' }} />
                      <button onClick={() => { setCustomModelAgents(prev => { const s = new Set(prev); s.delete(name); return s; }); setCustomModelValues(prev => { const p = { ...prev }; delete p[name]; return p; }); }}
                        style={{ background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-secondary, #888)',
                          border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer' }}>
                        List
                      </button>
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary, #666)', marginTop: '4px' }}>
                      Press Enter to save. Use format: model-name or provider/model-name
                    </div>
                  </div>
                ) : (
                  <select value={config.model}
                    onChange={(e) => {
                      if (e.target.value === '__custom__') { setCustomModelAgents(prev => new Set(prev).add(name)); }
                      else { updateAgent(name, { model: e.target.value }); }
                    }}
                    style={{ width: '100%', background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)',
                      border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '5px 8px', fontSize: '12px' }}>
                    {MODEL_OPTIONS.map(group => (
                      <optgroup key={group.group} label={group.group}>
                        {group.models.map(m => <option key={m} value={m}>{m}</option>)}
                      </optgroup>
                    ))}
                    <option value="__custom__">Custom model ID...</option>
                  </select>
                )}
              </div>

              {/* Debug/status message */}
              {updateErrors[name] && (
                <div style={{
                  fontSize: '11px',
                  padding: '4px 8px',
                  marginBottom: '8px',
                  borderRadius: '4px',
                  background: updateErrors[name].startsWith('Model set to:') ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)',
                  color: updateErrors[name].startsWith('Model set to:') ? '#4ade80' : '#f87171',
                  border: `1px solid ${updateErrors[name].startsWith('Model set to:') ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'}`
                }}>
                  {updateErrors[name]}
                </div>
              )}

              {/* Reasoning + Permissions */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', display: 'block', marginBottom: '4px' }}>Reasoning</label>
                  <select value={config.reasoning} onChange={(e) => updateAgent(name, { reasoning: e.target.value })}
                    style={{ width: '100%', background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)',
                      border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '5px 8px', fontSize: '12px' }}>
                    {REASONING_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', display: 'block', marginBottom: '4px' }}>Permissions</label>
                  <select value={config.permissions} onChange={(e) => updateAgent(name, { permissions: e.target.value })}
                    style={{ width: '100%', background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)',
                      border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '5px 8px', fontSize: '12px' }}>
                    {PERMISSION_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', marginTop: '8px' }}>
                {config.current_task && (
                  <div style={{ marginBottom: '4px' }}>Task: <span style={{ color: 'var(--text-primary, #e0e0e0)' }}>{config.current_task}</span></div>
                )}
                {config.tokens_used_today != null && config.tokens_used_today > 0 && (
                  <span>Tokens today: {config.tokens_used_today.toLocaleString()}</span>
                )}
              </div>

              {!isLeader && (
                <button onClick={() => setLeader(name)}
                  style={{ marginTop: '8px', width: '100%', background: 'transparent', color: 'var(--text-secondary, #888)',
                    border: '1px solid var(--border-color, #333)', borderRadius: '4px', padding: '4px', fontSize: '11px', cursor: 'pointer' }}>
                  Set as Leader
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
