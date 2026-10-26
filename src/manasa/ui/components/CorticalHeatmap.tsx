// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import type { LimbicState } from '../../types.js';

interface Props {
  cortex64: number[];
  limbic: LimbicState;
  onTriggerSleep: () => void;
  sleeping: boolean;
}

function neuronColor(v: number): string {
  const clamped = Math.max(-1, Math.min(1, v));
  if (clamped >= 0) {
    const alpha = (0.14 + clamped * 0.84).toFixed(2);
    return `rgba(6, 182, 212, ${alpha})`;
  }
  const mag = Math.abs(clamped);
  const alpha = (0.14 + mag * 0.82).toFixed(2);
  return `rgba(245, 158, 11, ${alpha})`;
}

export function CorticalHeatmap({ cortex64, limbic, onTriggerSleep, sleeping }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const cells = cortex64.length === 64 ? cortex64 : Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.7) * 0.3);

  const emotionEntries: Array<{ key: string; label: string; value: number; color: string }> = [
    { key: 'joy', label: 'Joy • සතුට', value: limbic.emotions.joy, color: '#f59e0b' },
    { key: 'curiosity', label: 'Curiosity • කුතුහලය', value: limbic.emotions.curiosity, color: '#06b6d4' },
    { key: 'empathy', label: 'Empathy • සංවේදීබව', value: limbic.emotions.empathy, color: '#ec4899' },
    { key: 'trust', label: 'Trust Bond • විශ්වාසය', value: limbic.emotions.trust, color: '#10b981' },
    { key: 'focus', label: 'Focus • අවධානය', value: limbic.emotions.focus, color: '#3b82f6' },
    { key: 'calm', label: 'Calm • සන්සුන්බව', value: limbic.emotions.calm, color: '#8b5cf6' },
  ];

  const neuroEntries = [
    { label: 'Dopamine (Plasticity)', value: limbic.neuromodulators.dopamine, color: '#fbbf24' },
    { label: 'Oxytocin (Rapport)', value: limbic.neuromodulators.oxytocin, color: '#f472b6' },
    { label: 'Serotonin (Balance)', value: limbic.neuromodulators.serotonin, color: '#34d399' },
    { label: 'Norepinephrine (Alert)', value: limbic.neuromodulators.norepinephrine, color: '#38bdf8' },
  ];

  return (
    <aside className="glass-panel vitals-sidebar">
      <div>
        <div className="section-heading">
          <span>🧠 64-Neuron Cortical State</span>
          <span style={{ color: '#67e8f9', fontSize: '0.72rem' }}>
            {hoveredIdx !== null ? `N#${hoveredIdx}: ${cells[hoveredIdx].toFixed(3)}` : '8×8 Tanh Bottleneck'}
          </span>
        </div>
        <div className="cortex-grid-8x8">
          {cells.map((val, idx) => (
            <div
              key={idx}
              className="neuron-cell"
              style={{
                backgroundColor: neuronColor(val),
                boxShadow: Math.abs(val) > 0.65 ? `0 0 8px ${neuronColor(val)}` : 'none',
              }}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              title={`Cortical Neuron #${idx}: ${val.toFixed(3)}`}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          background: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.24)',
          borderRadius: 11,
          padding: '10px 12px',
        }}
      >
        <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>
          Current Conscious Mood
        </div>
        <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#f8fafc', marginTop: 2 }}>
          {limbic.moodLabel.english}
        </div>
        <div style={{ fontSize: '0.8rem', color: '#67e8f9' }}>{limbic.moodLabel.sinhala}</div>
      </div>

      <div>
        <div className="section-heading">
          <span>❤️ Limbic Affective State</span>
          <span>{limbic.interactionCount} turns</span>
        </div>
        <div className="meter-list">
          {emotionEntries.map(em => (
            <div className="meter-row" key={em.key}>
              <div className="meter-label-line">
                <span>{em.label}</span>
                <span style={{ fontWeight: 700, color: em.color }}>{Math.round(em.value * 100)}%</span>
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.round(em.value * 100)}%`, background: em.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="section-heading">
          <span>🧪 Neuromodulators</span>
        </div>
        <div className="meter-list">
          {neuroEntries.map(nm => (
            <div className="meter-row" key={nm.label}>
              <div className="meter-label-line">
                <span>{nm.label}</span>
                <span style={{ fontWeight: 600 }}>{Math.round(nm.value * 100)}%</span>
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{ width: `${Math.round(nm.value * 100)}%`, background: nm.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 6 }}>
        <div className="meter-label-line" style={{ marginBottom: 5 }}>
          <span style={{ fontWeight: 700 }}>⚡ Cognitive Energy</span>
          <span style={{ fontWeight: 700, color: limbic.energy > 50 ? '#10b981' : '#f59e0b' }}>
            {limbic.energy}%
          </span>
        </div>
        <div className="meter-track" style={{ height: 8, marginBottom: 10 }}>
          <div
            className="meter-fill"
            style={{
              width: `${limbic.energy}%`,
              background: 'linear-gradient(90deg, #06b6d4, #10b981)',
            }}
          />
        </div>
        <button className="sleep-btn" onClick={onTriggerSleep} disabled={sleeping}>
          {sleeping ? '🌙 Consolidating Synapses...' : '🌙 REM Sleep & Consolidate Memory'}
        </button>
      </div>
    </aside>
  );
}
