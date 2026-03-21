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
  { group: 'Open Source', models: ['deepseek-v3.2', 'deepseek-r1', 'llama-4-scout', 'llama-4-maverick', 'qwen-3-235b', 'mistral-large-2'] },
  { group: 'OpenRouter (free)', models: [
    'xiaomi/mimo-v2-flash:free', 'stepfun/step-3.5-flash:free', 'deepseek/deepseek-chat-v3-0324:free',
    'nvidia/nemotron-3-super:free', 'moonshotai/kimi-k2.5:free', 'minimax/minimax-m2.7:free',
    'deepseek/deepseek-v3.2-speciale:free', 'qwen/qwen-3-235b:free'
  ]},
  { group: 'OpenRouter (paid)', models: [
    'anthropic/claude-sonnet-4', 'anthropic/claude-opus-4', 'openai/gpt-4.1', 'openai/gpt-4o',
    'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1',
    'meta-llama/llama-4-maverick', 'mistralai/mistral-large-2'
  ]},
];

const ALL_KNOWN_MODELS = new Set(MODEL_OPTIONS.flatMap(g => g.models));

// Validate model ID — returns error level: 'ok', 'warn', or 'block'
function validateModel(model: string): { level: 'ok' | 'warn' | 'block'; message?: string } {
  if (!model || model.length < 2) return { level: 'block', message: 'Model name is too short' };
  if (model.length > 100) return { level: 'block', message: 'Model name is too long' };
  if (/\s/.test(model)) return { level: 'block', message: 'Model name cannot contain spaces' };
  if (/[^a-zA-Z0-9\-_./:]/.test(model)) return { level: 'block', message: 'Model name contains invalid characters' };
  // Must contain at least one letter (pure numbers like "123" are not model IDs)
  if (!/[a-zA-Z]/.test(model)) return { level: 'block', message: 'Model name must contain letters (e.g. gpt-4o, claude-sonnet-4-6)' };
  // Must be at least 3 chars
  if (model.length < 3) return { level: 'block', message: 'Model name is too short' };
  // Exact match in our known dropdown list — always OK
  if (ALL_KNOWN_MODELS.has(model)) return { level: 'ok' };
  // Provider/model format for OpenRouter (e.g. openai/gpt-4o) — check the model part too
  if (model.includes('/') && model.split('/').length === 2) {
    const modelPart = model.split('/')[1];
    if (modelPart.length >= 3 && modelPart.includes('-')) return { level: 'ok' };
    if (modelPart.endsWith(':free')) return { level: 'ok' };
    return { level: 'warn', message: `"${modelPart}" after the provider doesn't look like a real model ID. Check the exact model name on the provider's website.` };
  }
  // NOT in our known list and not provider/model format — always warn
  return { level: 'warn', message: `"${model}" is not in the known models list. Use the List button to pick a valid model, or use provider/model format (e.g. openai/gpt-4o) for OpenRouter.` };
}

const REASONING_OPTIONS = ['standard', 'extended', 'minimal'];
const PERMISSION_OPTIONS = ['full', 'sandboxed', 'read-plan', 'supervised', 'off'];

export function TeamPanel({ controls, onRefresh }: TeamPanelProps) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [customModelAgents, setCustomModelAgents] = useState<Set<string>>(new Set());
  const [customModelValues, setCustomModelValues] = useState<Record<string, string>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});

  const updateAgent = useCallback(async (agent: string, patch: Partial<AgentConfig>, validationWarning?: string) => {
    setUpdating(agent);
    try {
      const res = await fetch(`${API_ENDPOINTS.CONTROLS}/${agent}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (!res.ok) {
        const errText = await res.text();
        setUpdateErrors(prev => ({ ...prev, [agent]: `Failed (${res.status}): ${errText}` }));
      } else if (patch.model) {
        if (validationWarning) {
          // Show the validation warning (yellow) — don't auto-dismiss
          setUpdateErrors(prev => ({ ...prev, [agent]: validationWarning }));
        } else {
          // Show green success — auto-dismiss after 3s
          setUpdateErrors(prev => ({ ...prev, [agent]: `OK: Model set to ${patch.model}` }));
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
                {customModelAgents.has(name) ? (
                  <div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <input type="text" value={customModelValues[name] ?? config.model}
                        onChange={(e) => {
                          setCustomModelValues(prev => ({ ...prev, [name]: e.target.value }));
                          // Clear any previous validation error while typing
                          if (updateErrors[name]?.startsWith('"')) setUpdateErrors(prev => { const p = { ...prev }; delete p[name]; return p; });
                        }}
                        onBlur={(e) => {
                          const val = e.target.value.trim();
                          if (val && val !== config.model) {
                            const v = validateModel(val);
                            if (v.level === 'block') { setUpdateErrors(prev => ({ ...prev, [name]: v.message || 'Invalid model' })); return; }
                            updateAgent(name, { model: val }, v.level === 'warn' ? v.message : undefined);
                          }
                          if (!val) setCustomModelAgents(prev => { const s = new Set(prev); s.delete(name); return s; });
                          setCustomModelValues(prev => { const p = { ...prev }; delete p[name]; return p; });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = (e.target as HTMLInputElement).value.trim();
                            if (val) {
                              const v = validateModel(val);
                              if (v.level === 'block') { setUpdateErrors(prev => ({ ...prev, [name]: v.message || 'Invalid model' })); return; }
                              updateAgent(name, { model: val }, v.level === 'warn' ? v.message : undefined);
                              setCustomModelValues(prev => { const p = { ...prev }; delete p[name]; return p; });
                            }
                          }
                        }}
                        placeholder="e.g. openai/gpt-4o or nvidia/nemotron-3-super:free" autoFocus
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
                  <select value={MODEL_OPTIONS.some(g => g.models.includes(config.model)) ? config.model : '__current__'}
                    onChange={(e) => {
                      if (e.target.value === '__custom__') { setCustomModelAgents(prev => new Set(prev).add(name)); }
                      else if (e.target.value !== '__current__') { updateAgent(name, { model: e.target.value }); }
                    }}
                    style={{ width: '100%', background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-primary, #e0e0e0)',
                      border: '1px solid var(--border-color, #444)', borderRadius: '4px', padding: '5px 8px', fontSize: '12px' }}>
                    {!MODEL_OPTIONS.some(g => g.models.includes(config.model)) && (
                      <option value="__current__">{config.model} (current)</option>
                    )}
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
              {updateErrors[name] && (() => {
                const msg = updateErrors[name];
                const isOk = msg.startsWith('OK:');
                const isWarn = msg.includes('not ') && !msg.startsWith('OK:') && !msg.startsWith('Failed') && !msg.startsWith('Error');
                const color = isOk ? '#4ade80' : isWarn ? '#facc15' : '#f87171';
                const bg = isOk ? 'rgba(74,222,128,0.1)' : isWarn ? 'rgba(250,204,21,0.1)' : 'rgba(248,113,113,0.1)';
                return (
                  <div style={{
                    fontSize: '11px', padding: '4px 8px', marginBottom: '8px', borderRadius: '4px',
                    background: bg, color, border: `1px solid ${color}33`
                  }}>
                    {isWarn && '⚠ '}{msg}
                  </div>
                );
              })()}

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

              {/* Token usage & status */}
              <div style={{ fontSize: '11px', color: 'var(--text-secondary, #888)', marginTop: '8px',
                padding: '8px', background: 'var(--bg-primary, #1a1a2e)', borderRadius: '6px' }}>
                {config.current_task && (
                  <div style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ color: '#60a5fa' }}>&#9654;</span>
                    <span style={{ color: 'var(--text-primary, #e0e0e0)' }}>{config.current_task}</span>
                  </div>
                )}
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <span style={{ color: 'var(--text-secondary, #666)' }}>Tokens today: </span>
                    <span style={{ color: '#facc15', fontFamily: 'monospace', fontWeight: 600 }}>
                      {config.tokens_used_today != null && config.tokens_used_today > 0
                        ? config.tokens_used_today.toLocaleString()
                        : '0'}
                    </span>
                  </div>
                  {config.context_window_pct != null && config.context_window_pct > 0 && (
                    <div>
                      <span style={{ color: 'var(--text-secondary, #666)' }}>Context: </span>
                      <span style={{
                        fontFamily: 'monospace', fontWeight: 600,
                        color: config.context_window_pct > 80 ? '#f87171' : config.context_window_pct > 50 ? '#facc15' : '#4ade80'
                      }}>
                        {config.context_window_pct}%
                      </span>
                    </div>
                  )}
                  {config.last_heartbeat && (
                    <div>
                      <span style={{ color: 'var(--text-secondary, #666)' }}>Last seen: </span>
                      <span style={{ fontFamily: 'monospace' }}>
                        {(() => {
                          const ago = Math.floor((Date.now() - config.last_heartbeat!) / 1000);
                          if (ago < 60) return `${ago}s ago`;
                          if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
                          return `${Math.floor(ago / 3600)}h ago`;
                        })()}
                      </span>
                    </div>
                  )}
                </div>
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
