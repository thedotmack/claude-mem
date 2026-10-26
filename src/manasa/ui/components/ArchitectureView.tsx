// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import type { ExternalCortexSettings, NeuralModelStats } from '../../types.js';

interface Props {
  stats: NeuralModelStats;
  externalSettings: {
    enabled: boolean;
    provider: ExternalCortexSettings['provider'];
    model: string;
    hasApiKey: boolean;
  };
  onSaveExternalSettings: (next: Partial<ExternalCortexSettings>) => Promise<void>;
}

export function ArchitectureView({ stats, externalSettings, onSaveExternalSettings }: Props) {
  const [enabled, setEnabled] = useState(externalSettings.enabled);
  const [provider, setProvider] = useState<ExternalCortexSettings['provider']>(externalSettings.provider);
  const [model, setModel] = useState(externalSettings.model);
  const [apiKey, setApiKey] = useState('');
  const [savedBanner, setSavedBanner] = useState(false);

  const [apiTestOutput, setApiTestOutput] = useState<string>('');
  const [testingApi, setTestingApi] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveExternalSettings({ enabled, provider, model, apiKey });
    setApiKey('');
    setSavedBanner(true);
    setTimeout(() => setSavedBanner(false), 3000);
  };

  const runLiveEndpointTest = async (endpoint: string, method: 'GET' | 'POST', body?: unknown) => {
    setTestingApi(true);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      setApiTestOutput(JSON.stringify(json, null, 2));
    } catch (err) {
      setApiTestOutput(String(err));
    } finally {
      setTestingApi(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Hero Banner with Generated Brain Visualization */}
      <div
        className="glass-panel"
        style={{
          overflow: 'hidden',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.2fr) minmax(280px, 0.8fr)',
          gap: 0,
        }}
      >
        <div style={{ padding: 26, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="brand-badge">MANASA-1 COGNITIVE ARCHITECTURE</span>
            <span style={{ fontSize: '0.75rem', color: '#67e8f9' }}>claude-mem v15 + Neural Cortex</span>
          </div>
          <h2 style={{ margin: 0, fontSize: '1.45rem', lineHeight: 1.25 }}>
            How MANASA-1 Thinks, Feels & Remembers Like a Human Brain
          </h2>
          <p style={{ margin: 0, color: '#cbd5e1', fontSize: '0.9rem' }}>
            Unlike stateless chatbots that forget everything when a window closes, MANASA-1 couples a trainable{' '}
            <strong>{stats.totalParameters.toLocaleString()}-parameter Gated Residual Neural Network</strong> with{' '}
            <code>claude-mem</code>'s persistent SQLite FTS5 memory store,{' '}
            <strong>Anderson & Schooler ACT-R power-law decay</strong> (<code>t^-0.5</code>), IDF-weighted{' '}
            <code>tfidfCosine</code> deduplication, and a homeostatic <strong>Limbic Emotion Engine</strong>.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginTop: 6 }}>
            {[
              { step: '01. Perception', desc: 'Singlish, සිංහල & English morphology + 384-dim feature projection' },
              { step: '02. Neural Cortex', desc: 'Gated context residual + 64-neuron bottleneck + Dual Softmax/Affect heads' },
              { step: '03. Hippocampus', desc: 'claude-mem SQLite FTS5 + ACT-R spaced reinforcement + Knowledge Graph' },
              { step: '04. Limbic & Broca', desc: 'Dopamine/Oxytocin dynamics + mood-modulated trilingual speech' },
            ].map(card => (
              <div
                key={card.step}
                style={{
                  background: 'rgba(6, 9, 17, 0.78)',
                  border: '1px solid rgba(148, 163, 184, 0.16)',
                  borderRadius: 11,
                  padding: '10px 12px',
                }}
              >
                <div style={{ fontSize: '0.76rem', fontWeight: 800, color: '#fbbf24' }}>{card.step}</div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 3 }}>{card.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ minHeight: 260, position: 'relative' }}>
          <img
            src="/assets/manasa-hero-brain.jpg"
            alt="MANASA-1 Synthetic Hippocampus & Neocortex"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
      </div>

      <div className="lab-grid">
        {/* Optional External Cloud LLM Bridge */}
        <form className="glass-panel" style={{ padding: 20 }} onSubmit={handleSave}>
          <h3 style={{ margin: '0 0 4px', fontSize: '1.02rem' }}>
            🔌 Optional Hybrid Cloud LLM Bridge (100% Optional)
          </h3>
          <p style={{ margin: '0 0 14px', fontSize: '0.79rem', color: '#94a3b8' }}>
            MANASA-1 runs 100% locally out-of-the-box with zero API keys. Optionally attach OpenAI, Gemini, Claude, or OpenRouter to blend cloud LLM generation with local claude-mem recall & limbic emotions.
          </p>

          <div className="form-field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={e => setEnabled(e.target.checked)}
              />
              Enable Hybrid External LLM Synthesis
            </label>
          </div>

          <div className="form-field">
            <label>Provider</label>
            <select
              className="text-input"
              value={provider}
              onChange={e => setProvider(e.target.value as ExternalCortexSettings['provider'])}
            >
              <option value="none">Local Neural Cortex Only (Default — Zero API Key)</option>
              <option value="openai">OpenAI (gpt-4o-mini / gpt-4o)</option>
              <option value="gemini">Google Gemini (gemini-2.0-flash)</option>
              <option value="anthropic">Anthropic Claude (claude-3-5-sonnet)</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </div>

          <div className="form-field">
            <label>Model Name (optional override)</label>
            <input
              className="text-input"
              placeholder="e.g. gpt-4o-mini or gemini-2.0-flash"
              value={model}
              onChange={e => setModel(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label>
              API Key {externalSettings.hasApiKey ? '(Key stored in memory — enter to replace)' : '(Never persisted to git)'}
            </label>
            <input
              type="password"
              className="text-input"
              placeholder="sk-... / AIza..."
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
          </div>

          <button type="submit" className="primary-action-btn">
            Save Cortex Bridge Settings
          </button>

          {savedBanner && (
            <span style={{ marginLeft: 12, color: '#34d399', fontSize: '0.8rem', fontWeight: 600 }}>
              ✓ Saved!
            </span>
          )}
        </form>

        {/* Live REST API Playground */}
        <div className="glass-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '1.02rem' }}>⚡ Live Model & Memory REST API Playground</h3>
            <p style={{ margin: 0, fontSize: '0.79rem', color: '#94a3b8' }}>
              Test MANASA-1's cognitive endpoints directly from your browser and inspect the raw JSON telemetry:
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="control-pill active"
              disabled={testingApi}
              onClick={() => runLiveEndpointTest('/api/state', 'GET')}
            >
              GET /api/state
            </button>
            <button
              type="button"
              className="control-pill active"
              disabled={testingApi}
              onClick={() =>
                runLiveEndpointTest('/api/probe', 'POST', {
                  text: 'Kohomada machan! Oyage molaya wada karanne kohomada?',
                })
              }
            >
              POST /api/probe
            </button>
            <button
              type="button"
              className="control-pill active"
              disabled={testingApi}
              onClick={() => runLiveEndpointTest('/api/graph', 'GET')}
            >
              GET /api/graph
            </button>
            <button
              type="button"
              className="control-pill active"
              disabled={testingApi}
              onClick={() => runLiveEndpointTest('/api/memories', 'GET')}
            >
              GET /api/memories
            </button>
          </div>

          <pre
            style={{
              flex: 1,
              minHeight: 200,
              maxHeight: 290,
              overflow: 'auto',
              margin: 0,
              padding: 12,
              borderRadius: 10,
              background: '#050811',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              color: '#67e8f9',
              fontSize: '0.75rem',
            }}
          >
            {apiTestOutput || '// Click any endpoint button above to inspect live neural & claude-mem telemetry...'}
          </pre>
        </div>
      </div>
    </div>
  );
}
