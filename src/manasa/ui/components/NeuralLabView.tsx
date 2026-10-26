// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import {
  COGNITIVE_INTENTS,
  type CognitiveIntent,
  type LanguageAnalysis,
  type NeuralForwardResult,
  type NeuralModelStats,
} from '../../types.js';

interface Props {
  stats: NeuralModelStats;
  onRunEpochs: (epochs: number, lr: number) => Promise<void>;
  onTeachSample: (phrase: string, intent: CognitiveIntent, customReply: string) => Promise<void>;
  onProbe: (text: string) => Promise<{ language: LanguageAnalysis; neural: NeuralForwardResult }>;
}

const PROBE_PRESETS = [
  'Kohomada machan! Mage aluth AI startup ekata plan ekak hadamu',
  'මට අද ගොඩක් සතුටුයි, මගේ project එක සාර්ථක වුණා!',
  'Solve step by step: (512 * 8) - 240',
  'TypeScript walin binary search function ekak liyanna',
];

export function NeuralLabView({ stats, onRunEpochs, onTeachSample, onProbe }: Props) {
  const [probeText, setProbeText] = useState(PROBE_PRESETS[0]);
  const [probeResult, setProbeResult] = useState<{
    language: LanguageAnalysis;
    neural: NeuralForwardResult;
  } | null>(null);
  const [probing, setProbing] = useState(false);

  const [epochs, setEpochs] = useState(20);
  const [lr, setLr] = useState(0.008);
  const [training, setTraining] = useState(false);

  const [teachPhrase, setTeachPhrase] = useState('');
  const [teachIntent, setTeachIntent] = useState<CognitiveIntent>('casual_chat');
  const [teachReply, setTeachReply] = useState('');
  const [teaching, setTeaching] = useState(false);
  const [teachSuccess, setTeachSuccess] = useState<string | null>(null);

  const runProbeNow = async (textToProbe: string) => {
    if (!textToProbe.trim()) return;
    setProbing(true);
    try {
      const res = await onProbe(textToProbe);
      setProbeResult(res);
    } finally {
      setProbing(false);
    }
  };

  React.useEffect(() => {
    runProbeNow(PROBE_PRESETS[0]);
  }, []);

  const handleTrain = async () => {
    setTraining(true);
    try {
      await onRunEpochs(epochs, lr);
      if (probeText.trim()) await runProbeNow(probeText);
    } finally {
      setTraining(false);
    }
  };

  const handleTeach = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teachPhrase.trim()) return;
    setTeaching(true);
    setTeachSuccess(null);
    try {
      await onTeachSample(teachPhrase.trim(), teachIntent, teachReply.trim());
      setTeachSuccess(`Updated neural weights online & persisted "${teachPhrase.trim()}" into claude-mem!`);
      setProbeText(teachPhrase.trim());
      await runProbeNow(teachPhrase.trim());
      setTeachPhrase('');
      setTeachReply('');
    } finally {
      setTeaching(false);
    }
  };

  // Render SVG Loss Curve
  const history = stats.history.slice(-50);
  const maxLoss = Math.max(0.5, ...history.map(h => h.totalLoss));
  const svgW = 540;
  const svgH = 165;
  const pad = 22;

  const lossPoints = history
    .map((pt, idx) => {
      const x = pad + (idx / Math.max(1, history.length - 1)) * (svgW - pad * 2);
      const y = svgH - pad - (pt.totalLoss / maxLoss) * (svgH - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const accPoints = history
    .map((pt, idx) => {
      const x = pad + (idx / Math.max(1, history.length - 1)) * (svgW - pad * 2);
      const y = svgH - pad - pt.accuracy * (svgH - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <div className="lab-grid">
      {/* Left: Live Neural Utterance Probe */}
      <div className="glass-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 15 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.08rem' }}>
            🔬 Live Cortical Forward-Pass Probe (Singlish • සිංහල • English)
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
            Inspect real-time token hashing, 64-dim bottleneck norms, 14-way softmax probabilities, and affective appraisal
          </p>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PROBE_PRESETS.map((preset, i) => (
            <button
              key={i}
              type="button"
              className="mini-action-btn"
              onClick={() => {
                setProbeText(preset);
                runProbeNow(preset);
              }}
            >
              Sample #{i + 1}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="text-input"
            style={{ flex: 1 }}
            value={probeText}
            onChange={e => setProbeText(e.target.value)}
            placeholder="Type any Singlish, සිංහල, or English sentence to probe neural activations..."
          />
          <button
            type="button"
            className="primary-action-btn"
            onClick={() => runProbeNow(probeText)}
            disabled={probing}
          >
            {probing ? 'Running...' : '⚡ Probe Cortex'}
          </button>
        </div>

        {probeResult && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              <div style={{ background: 'rgba(6, 182, 212, 0.1)', borderRadius: 10, padding: '8px 11px' }}>
                <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>DETECTED LANGUAGE</div>
                <div style={{ fontSize: '0.96rem', fontWeight: 800, color: '#67e8f9', textTransform: 'uppercase' }}>
                  {probeResult.language.detected} ({Math.round(probeResult.language.confidence * 100)}%)
                </div>
              </div>
              <div style={{ background: 'rgba(245, 158, 11, 0.1)', borderRadius: 10, padding: '8px 11px' }}>
                <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>TOP INTENT</div>
                <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#fbbf24' }}>
                  {probeResult.neural.topIntent} ({(probeResult.neural.confidence * 100).toFixed(1)}%)
                </div>
              </div>
              <div style={{ background: 'rgba(16, 185, 129, 0.1)', borderRadius: 10, padding: '8px 11px' }}>
                <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>AFFECT VALENCE</div>
                <div style={{ fontSize: '0.96rem', fontWeight: 800, color: '#34d399' }}>
                  {probeResult.neural.affect.valence >= 0 ? '+' : ''}
                  {probeResult.neural.affect.valence} • H={probeResult.neural.entropy}b
                </div>
              </div>
            </div>

            <div>
              <div className="section-heading">
                <span>Top-7 Softmax Cognitive Intent Distribution</span>
                <span>Layer Norms: L1={probeResult.neural.layerNorms.embedding96Norm} | L3={probeResult.neural.layerNorms.cortex64Norm}</span>
              </div>
              <div className="meter-list">
                {probeResult.neural.intentRanking.slice(0, 7).map((item, idx) => (
                  <div className="meter-row" key={item.intent}>
                    <div className="meter-label-line">
                      <span>
                        <strong>{item.intent}</strong> — <span style={{ color: '#94a3b8' }}>{item.labelSi}</span>
                      </span>
                      <span style={{ fontWeight: 700, color: idx === 0 ? '#06b6d4' : '#cbd5e1' }}>
                        {(item.probability * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="meter-track">
                      <div
                        className="meter-fill"
                        style={{
                          width: `${Math.max(1.5, item.probability * 100)}%`,
                          background: idx === 0 ? 'linear-gradient(90deg, #06b6d4, #f59e0b)' : '#334155',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Right: Backpropagation Training Studio & Online Neuroplasticity */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="glass-panel" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.06rem' }}>⚡ Live Backpropagation & AdamW Training</h2>
              <p style={{ margin: '3px 0 0', fontSize: '0.78rem', color: '#94a3b8' }}>
                {stats.architecture}
              </p>
            </div>
            <span className="brand-badge">{stats.totalParameters.toLocaleString()} Trainable Weights</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, margin: '14px 0' }}>
            {[
              { label: 'Epochs Run', val: stats.trainedEpochs, color: '#06b6d4' },
              { label: 'Corpus Size', val: stats.corpusSize, color: '#a855f7' },
              { label: 'Total Loss', val: stats.lastLoss.toFixed(4), color: '#f59e0b' },
              { label: 'Accuracy', val: `${(stats.lastAccuracy * 100).toFixed(1)}%`, color: '#10b981' },
            ].map(s => (
              <div
                key={s.label}
                style={{
                  background: 'rgba(7, 11, 21, 0.85)',
                  border: '1px solid rgba(148, 163, 184, 0.14)',
                  borderRadius: 10,
                  padding: '8px 10px',
                }}
              >
                <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>{s.label}</div>
                <div style={{ fontSize: '1.05rem', fontWeight: 800, color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>

          {/* SVG Loss & Accuracy Chart */}
          <div
            style={{
              background: '#050811',
              border: '1px solid rgba(148, 163, 184, 0.16)',
              borderRadius: 12,
              padding: 10,
              marginBottom: 14,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8', marginBottom: 4 }}>
              <span style={{ color: '#f59e0b' }}>━ Cross-Entropy + Affect MSE Loss</span>
              <span style={{ color: '#10b981' }}>━ Training Accuracy</span>
            </div>
            <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: '100%', height: 150, display: 'block' }}>
              <line x1={pad} y1={svgH - pad} x2={svgW - pad} y2={svgH - pad} stroke="rgba(148,163,184,0.2)" />
              <line x1={pad} y1={pad} x2={pad} y2={svgH - pad} stroke="rgba(148,163,184,0.2)" />
              {history.length > 1 && (
                <>
                  <polyline fill="none" stroke="#10b981" strokeWidth="2.2" points={accPoints} />
                  <polyline fill="none" stroke="#f59e0b" strokeWidth="2.4" points={lossPoints} />
                </>
              )}
            </svg>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '0.79rem', color: '#cbd5e1' }}>
              Epochs:{' '}
              <select
                className="lang-select"
                value={epochs}
                onChange={e => setEpochs(Number(e.target.value))}
              >
                <option value={10}>10 Epochs</option>
                <option value={20}>20 Epochs</option>
                <option value={40}>40 Epochs</option>
              </select>
            </label>
            <label style={{ fontSize: '0.79rem', color: '#cbd5e1' }}>
              LR:{' '}
              <select className="lang-select" value={lr} onChange={e => setLr(Number(e.target.value))}>
                <option value={0.012}>0.012 (Fast)</option>
                <option value={0.008}>0.008 (Balanced)</option>
                <option value={0.003}>0.003 (Fine-tune)</option>
              </select>
            </label>
            <button type="button" className="primary-action-btn" onClick={handleTrain} disabled={training}>
              {training ? 'Training Weights...' : `🚀 Run ${epochs} Backprop Epochs`}
            </button>
          </div>
        </div>

        {/* Online Teaching Card */}
        <form className="glass-panel" style={{ padding: 20 }} onSubmit={handleTeach}>
          <h3 style={{ margin: '0 0 4px', fontSize: '1rem' }}>
            🎓 Live Neuroplasticity — Teach MANASA-1 New Phrase / Reflex
          </h3>
          <p style={{ margin: '0 0 12px', fontSize: '0.78rem', color: '#94a3b8' }}>
            Trains neural weights online immediately + saves custom reflex into claude-mem SQLite!
          </p>

          <div className="form-field">
            <label>Trigger Phrase (Singlish, සිංහල, or English)</label>
            <input
              className="text-input"
              placeholder='e.g. "Api dinamu machan" or "Project Lankaverse gana kiyanna"'
              value={teachPhrase}
              onChange={e => setTeachPhrase(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label>Cognitive Intent Class</label>
            <select
              className="text-input"
              value={teachIntent}
              onChange={e => setTeachIntent(e.target.value as CognitiveIntent)}
            >
              {COGNITIVE_INTENTS.map(intent => (
                <option key={intent} value={intent}>
                  {intent}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label>Optional Custom Response (when user says this phrase in chat)</label>
            <input
              className="text-input"
              placeholder='e.g. "Aniwaaryenma machan! Api ekathu wela supirima deyak hadamu! 🚀"'
              value={teachReply}
              onChange={e => setTeachReply(e.target.value)}
            />
          </div>

          <button type="submit" className="primary-action-btn" disabled={teaching || !teachPhrase.trim()}>
            {teaching ? 'Encoding Synapse...' : '🧠 Teach & Update Neural Weights'}
          </button>

          {teachSuccess && (
            <div
              style={{
                marginTop: 10,
                padding: '8px 12px',
                borderRadius: 9,
                background: 'rgba(16, 185, 129, 0.14)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                color: '#6ee7b7',
                fontSize: '0.79rem',
              }}
            >
              ✅ {teachSuccess}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
