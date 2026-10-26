// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from 'react';
import type {
  ChatTurn,
  CognitiveIntent,
  ExternalCortexSettings,
  KnowledgeGraphData,
  LanguageAnalysis,
  LanguagePreference,
  LimbicState,
  NeuralForwardResult,
  NeuralModelStats,
  RecalledMemory,
} from '../types.js';
import { ArchitectureView } from './components/ArchitectureView.js';
import { CorticalHeatmap } from './components/CorticalHeatmap.js';
import { MemoryVaultView } from './components/MemoryVaultView.js';
import { NeuralLabView } from './components/NeuralLabView.js';

type ActiveTab = 'mind' | 'vault' | 'lab' | 'architecture';

const STARTER_PROMPTS = [
  {
    tag: 'Singlish • Memory + Bond',
    text: 'Kohomada machan! Mage nama Rusindu, mama inne Pita Kotte, mage goal eka supiri AI startup ekak hadana eka.',
  },
  {
    tag: 'සිංහල • Self-Awareness',
    text: 'ආයුබෝවන්! ඔයා කවුද? ඔයාගේ මොළය සහ claude-mem මතකය වැඩ කරන්නේ කොහොමද?',
  },
  {
    tag: 'Singlish • Memory Recall',
    text: 'Mage nama mokakda, mama koheda inne saha mage goal eka mokakda kiyala oyata mathakada?',
  },
  {
    tag: 'English • Math & Reasoning',
    text: 'Solve step by step: (245 * 18) + 640',
  },
  {
    tag: 'Singlish • Empathy',
    text: 'Mata ada wada wadi wela godak mahansi machan, poddak hitha hadenna katha karamuda?',
  },
  {
    tag: 'Code • Engineering',
    text: 'TypeScript walin clean binary search function ekak liyala pennanna',
  },
];

/**
 * Lightweight, safe Markdown + Fenced Code Block renderer for assistant turns.
 */
function FormattedContent({ text }: { text: string }) {
  const segments = text.split(/(```[\s\S]*?```)/g);

  const renderInline = (line: string, keyPrefix: string) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((p, i) => {
      if (p.startsWith('**') && p.endsWith('**')) {
        return <strong key={`${keyPrefix}-${i}`}>{p.slice(2, -2)}</strong>;
      }
      if (p.startsWith('`') && p.endsWith('`')) {
        return <code key={`${keyPrefix}-${i}`}>{p.slice(1, -1)}</code>;
      }
      return <React.Fragment key={`${keyPrefix}-${i}`}>{p}</React.Fragment>;
    });
  };

  return (
    <div className="msg-content">
      {segments.map((seg, idx) => {
        if (seg.startsWith('```') && seg.endsWith('```')) {
          const inner = seg.slice(3, -3).replace(/^[a-zA-Z]+\n/, '');
          return (
            <pre key={idx}>
              <code>{inner}</code>
            </pre>
          );
        }

        const paragraphs = seg.split(/\n\n+/).filter(Boolean);
        return paragraphs.map((para, pIdx) => {
          if (para.trim().startsWith('>')) {
            const quoteText = para
              .split('\n')
              .map(l => l.replace(/^>\s?/, ''))
              .join('\n');
            return (
              <blockquote key={`${idx}-${pIdx}`}>
                {quoteText.split('\n').map((l, lIdx) => (
                  <div key={lIdx}>{renderInline(l, `${idx}-${pIdx}-${lIdx}`)}</div>
                ))}
              </blockquote>
            );
          }

          return (
            <p key={`${idx}-${pIdx}`}>
              {para.split('\n').map((line, lIdx, arr) => (
                <React.Fragment key={lIdx}>
                  {renderInline(line, `${idx}-${pIdx}-${lIdx}`)}
                  {lIdx < arr.length - 1 && <br />}
                </React.Fragment>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('mind');
  const [languagePref, setLanguagePref] = useState<LanguagePreference>('auto');
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [micLang, setMicLang] = useState<'en-US' | 'si-LK'>('en-US');
  const [recording, setRecording] = useState(false);

  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [sleeping, setSleeping] = useState(false);

  const [cortex64, setCortex64] = useState<number[]>([]);
  const [limbic, setLimbic] = useState<LimbicState>({
    emotions: { joy: 0.68, curiosity: 0.78, empathy: 0.72, trust: 0.64, calm: 0.75, focus: 0.74 },
    neuromodulators: { dopamine: 0.7, serotonin: 0.74, oxytocin: 0.62, norepinephrine: 0.66 },
    energy: 92,
    dominantEmotion: 'curiosity',
    moodLabel: {
      english: 'Deeply Curious & Inquisitive',
      sinhala: 'කුතුහලයෙන් සහ ගවේෂණශීලීව',
      singlish: 'Kuthuhalayen saha aluth dewal hoyamin',
    },
    voiceProsody: { pitch: 1.0, rate: 1.0 },
    interactionCount: 0,
  });

  const [stats, setStats] = useState<NeuralModelStats>({
    architecture: '384 → 96 → Gated(96) → Tanh(64) → DualHead',
    inputDim: 384,
    embeddingDim: 96,
    gatedDim: 96,
    bottleneckDim: 64,
    numIntents: 14,
    totalParameters: 62962,
    trainedEpochs: 38,
    onlineUpdates: 0,
    corpusSize: 164,
    lastLoss: 0.04,
    lastAccuracy: 1,
    history: [],
  });

  const [memories, setMemories] = useState<RecalledMemory[]>([]);
  const [graph, setGraph] = useState<KnowledgeGraphData>({
    nodes: [],
    edges: [],
    stats: {
      totalMemories: 0,
      manualFacts: 0,
      episodicMemories: 0,
      consolidatedSummaries: 0,
      conceptCount: 0,
      avgActRStrength: 0.8,
    },
  });

  const [externalSettings, setExternalSettings] = useState<{
    enabled: boolean;
    provider: ExternalCortexSettings['provider'];
    model: string;
    hasApiKey: boolean;
  }>({
    enabled: false,
    provider: 'none',
    model: '',
    hasApiKey: false,
  });

  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any>(null);

  const refreshState = async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const data = (await res.json()) as any;
      if (data.limbic) setLimbic(data.limbic);
      if (data.stats) setStats(data.stats);
      if (data.memories) setMemories(data.memories);
      if (data.graph) setGraph(data.graph);
      if (data.history) setMessages(data.history);
      if (data.externalSettings) setExternalSettings(data.externalSettings);
    } catch {
      // Ignore transient initial fetch issues
    }
  };

  useEffect(() => {
    refreshState();
  }, []);

  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const speakUtterance = (text: string, prosody = limbic.voiceProsody, lang?: string) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const plain = text
      .replace(/```[\s\S]*?```/g, ' Code snippet generated. ')
      .replace(/[*#>`_]/g, '')
      .slice(0, 550);
    const utter = new SpeechSynthesisUtterance(plain);
    utter.lang = lang === 'sinhala' ? 'si-LK' : 'en-US';
    utter.pitch = prosody.pitch;
    utter.rate = prosody.rate;
    window.speechSynthesis.speak(utter);
  };

  const sendMessage = async (rawText?: string) => {
    const content = (rawText ?? input).trim();
    if (!content || sending) return;
    if (!rawText) setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, languagePref }),
      });
      const data = (await res.json()) as any;
      if (data.userTurn && data.assistantTurn) {
        setMessages(prev => [...prev, data.userTurn, data.assistantTurn]);
        // Auto-expand inner thoughts on the very first turn so the user sees the brain working!
        if (messages.length === 0) {
          setExpandedThoughts(prev => ({ ...prev, [data.assistantTurn.id]: true }));
        }
        if (data.assistantTurn.neural?.cortex64) {
          setCortex64(data.assistantTurn.neural.cortex64);
        }
        if (data.limbic) setLimbic(data.limbic);
        if (data.stats) setStats(data.stats);
        if (data.graph) setGraph(data.graph);
        if (data.memories) setMemories(data.memories);

        if (autoSpeak) {
          speakUtterance(
            data.assistantTurn.content,
            data.limbic?.voiceProsody ?? limbic.voiceProsody,
            data.assistantTurn.language,
          );
        }
      }
    } finally {
      setSending(false);
    }
  };

  const toggleVoiceMic = () => {
    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      alert('Speech recognition is supported in Chrome / Edge browsers.');
      return;
    }

    if (recording && recognitionRef.current) {
      recognitionRef.current.stop();
      setRecording(false);
      return;
    }

    const rec = new SpeechRec();
    rec.lang = micLang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setRecording(true);
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    rec.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript;
      if (transcript) {
        setInput(prev => (prev ? `${prev} ${transcript}` : transcript));
      }
    };
    recognitionRef.current = rec;
    rec.start();
  };

  const handleTriggerSleep = async () => {
    setSleeping(true);
    try {
      const res = await fetch('/api/consolidate', { method: 'POST' });
      const data = (await res.json()) as any;
      if (data.limbic) setLimbic(data.limbic);
      if (data.graph) setGraph(data.graph);
      if (data.memories) setMemories(data.memories);
    } finally {
      setSleeping(false);
    }
  };

  const handleSearchMemories = async (kind: string, q: string) => {
    const params = new URLSearchParams();
    if (kind && kind !== 'all') params.set('kind', kind);
    if (q.trim()) params.set('q', q.trim());
    const res = await fetch(`/api/memories?${params.toString()}`);
    const data = (await res.json()) as any;
    if (data.memories) setMemories(data.memories);
  };

  const handleAddExplicitMemory = async (factText: string) => {
    const res = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: factText }),
    });
    const data = (await res.json()) as any;
    if (data.memories) setMemories(data.memories);
    if (data.graph) setGraph(data.graph);
  };

  const handleReinforceMemory = async (id: string) => {
    const res = await fetch(`/api/memories/${encodeURIComponent(id)}/reinforce`, {
      method: 'POST',
    });
    const data = (await res.json()) as any;
    if (data.memories) setMemories(data.memories);
    if (data.graph) setGraph(data.graph);
  };

  const handleDeleteMemory = async (id: string) => {
    const res = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const data = (await res.json()) as any;
    if (data.memories) setMemories(data.memories);
    if (data.graph) setGraph(data.graph);
  };

  const handleRunEpochs = async (epochs: number, lr: number) => {
    const res = await fetch('/api/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epochs, learningRate: lr }),
    });
    const data = (await res.json()) as any;
    if (data.stats) setStats(data.stats);
  };

  const handleTeachSample = async (
    phrase: string,
    intent: CognitiveIntent,
    customReply: string,
  ) => {
    const res = await fetch('/api/teach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phrase, intent, customReply }),
    });
    const data = (await res.json()) as any;
    if (data.stats) setStats(data.stats);
    if (data.memories) setMemories(data.memories);
    if (data.graph) setGraph(data.graph);
  };

  const handleProbe = async (
    text: string,
  ): Promise<{ language: LanguageAnalysis; neural: NeuralForwardResult }> => {
    const res = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return (await res.json()) as { language: LanguageAnalysis; neural: NeuralForwardResult };
  };

  const handleSaveExternalSettings = async (next: Partial<ExternalCortexSettings>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    const data = (await res.json()) as any;
    if (data.externalSettings) setExternalSettings(data.externalSettings);
  };

  return (
    <div className="manasa-shell">
      {/* Sticky Top Header */}
      <header className="manasa-topbar">
        <div className="brand-cluster">
          <div className="brand-avatar-wrap">
            <img src="/assets/manasa-avatar.png" alt="MANASA-1" className="brand-avatar" />
            <span className="brand-pulse-dot" />
          </div>
          <div>
            <h1 className="brand-title">
              MANASA-1 <span style={{ color: '#67e8f9', fontWeight: 500 }}>මනස-1</span>
              <span className="brand-badge">claude-mem Brain</span>
            </h1>
            <p className="brand-sub">
              {stats.totalParameters.toLocaleString()} Neural Params • {graph.stats.totalMemories} Persistent Memories • {limbic.energy}% Energy
            </p>
          </div>
        </div>

        <nav className="nav-tabs">
          <button
            type="button"
            className={`nav-tab-btn ${activeTab === 'mind' ? 'active' : ''}`}
            onClick={() => setActiveTab('mind')}
          >
            🧠 Mind & Chat
          </button>
          <button
            type="button"
            className={`nav-tab-btn ${activeTab === 'vault' ? 'active' : ''}`}
            onClick={() => setActiveTab('vault')}
          >
            🕸️ Memory Graph ({graph.stats.totalMemories})
          </button>
          <button
            type="button"
            className={`nav-tab-btn ${activeTab === 'lab' ? 'active' : ''}`}
            onClick={() => setActiveTab('lab')}
          >
            ⚡ Neural Cortex Lab
          </button>
          <button
            type="button"
            className={`nav-tab-btn ${activeTab === 'architecture' ? 'active' : ''}`}
            onClick={() => setActiveTab('architecture')}
          >
            🔬 Architecture & API
          </button>
        </nav>

        <div className="topbar-controls">
          <select
            className="lang-select"
            value={languagePref}
            onChange={e => setLanguagePref(e.target.value as LanguagePreference)}
            title="AI Response Language Preference"
          >
            <option value="auto">🌐 Auto (Singlish / සිංහල / EN)</option>
            <option value="singlish">🇱🇰 Singlish Mode</option>
            <option value="sinhala">🇱🇰 සිංහල Mode</option>
            <option value="english">🇬🇧 English Mode</option>
          </select>

          <button
            type="button"
            className={`control-pill ${autoSpeak ? 'active' : ''}`}
            onClick={() => setAutoSpeak(v => !v)}
            title="Toggle Mood-Modulated Voice Speech Output"
          >
            {autoSpeak ? '🔊 Voice ON' : '🔈 Voice OFF'}
          </button>
        </div>
      </header>

      {/* Tab 1: Mind & Chat */}
      {activeTab === 'mind' && (
        <div className="mind-grid">
          <section className="glass-panel chat-column">
            <div className="chat-stream">
              {messages.length === 0 && (
                <div className="hero-welcome">
                  <div className="hero-welcome-top">
                    <img
                      src="/assets/manasa-avatar.png"
                      alt="MANASA-1 Avatar"
                      className="hero-avatar-lg"
                    />
                    <div>
                      <h2 style={{ margin: '0 0 4px', fontSize: '1.22rem' }}>
                        ආයුබෝවන්! Ayubowan! I am <span style={{ color: '#67e8f9' }}>MANASA-1</span> 🧠✨
                      </h2>
                      <p style={{ margin: 0, fontSize: '0.86rem', color: '#cbd5e1' }}>
                        A living human-like cognitive AI powered by <strong>claude-mem</strong> persistent SQLite memory,{' '}
                        <strong>ACT-R power-law reinforcement</strong>, a trainable <strong>62,962-parameter Neural Cortex</strong>, and live{' '}
                        <strong>Limbic Emotions</strong>. Talk to me in <strong>Singlish, සිංහල, or English</strong>!
                      </p>
                    </div>
                  </div>

                  <div className="starter-grid">
                    {STARTER_PROMPTS.map((sp, i) => (
                      <button
                        key={i}
                        type="button"
                        className="starter-chip"
                        onClick={() => sendMessage(sp.text)}
                      >
                        <span className="starter-chip-tag">{sp.tag}</span>
                        <span>{sp.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {messages.map(turn => {
                const isOpen = Boolean(expandedThoughts[turn.id]);
                return (
                  <div key={turn.id} className={`msg-row ${turn.role}`}>
                    {turn.role === 'assistant' ? (
                      <img src="/assets/manasa-avatar.png" alt="MANASA" className="msg-avatar" />
                    ) : (
                      <div className="msg-user-badge">YOU</div>
                    )}

                    <div className="msg-bubble">
                      <FormattedContent text={turn.content} />

                      {turn.role === 'assistant' && turn.innerThoughts && (
                        <div className="thought-drawer">
                          <div className="thought-toggle-row">
                            <button
                              type="button"
                              className="thought-toggle-btn"
                              onClick={() =>
                                setExpandedThoughts(prev => ({ ...prev, [turn.id]: !prev[turn.id] }))
                              }
                            >
                              {isOpen ? '▾ Hide Inner Thoughts' : '▸ Inspect Inner Monologue (5 Brain Stages)'}
                              {turn.neural
                                ? ` • ${turn.neural.topIntent} (${Math.round(turn.neural.confidence * 100)}%)`
                                : ''}
                            </button>

                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              {turn.learnedFacts && turn.learnedFacts.length > 0 && (
                                <span
                                  style={{
                                    fontSize: '0.7rem',
                                    color: '#34d399',
                                    fontWeight: 700,
                                  }}
                                >
                                  +{turn.learnedFacts.length} Memory Saved
                                </span>
                              )}
                              <button
                                type="button"
                                className="mini-action-btn"
                                onClick={() =>
                                  speakUtterance(
                                    turn.content,
                                    turn.limbicSnapshot?.voiceProsody ?? limbic.voiceProsody,
                                    turn.language,
                                  )
                                }
                                title="Speak this message aloud"
                              >
                                🔊 Speak
                              </button>
                            </div>
                          </div>

                          {isOpen && (
                            <div className="thought-steps-list">
                              {turn.innerThoughts.map((st, idx) => (
                                <div className="thought-step-card" key={idx}>
                                  <div className="thought-step-header">
                                    <span>
                                      {st.titleEn} • <span style={{ color: '#67e8f9', fontWeight: 500 }}>{st.titleSi}</span>
                                    </span>
                                    <span style={{ color: '#fbbf24' }}>{st.durationMs}ms</span>
                                  </div>
                                  <div className="thought-step-summary">{st.summary}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {sending && (
                <div className="msg-row assistant">
                  <img src="/assets/manasa-avatar.png" alt="MANASA" className="msg-avatar" />
                  <div className="msg-bubble" style={{ color: '#67e8f9', fontSize: '0.86rem' }}>
                    🧠 Firing neural cortex & querying claude-mem hippocampus...
                  </div>
                </div>
              )}

              <div ref={streamEndRef} />
            </div>

            {/* Composer */}
            <form
              className="composer-bar"
              onSubmit={e => {
                e.preventDefault();
                sendMessage();
              }}
            >
              <select
                className="lang-select"
                style={{ height: 46 }}
                value={micLang}
                onChange={e => setMicLang(e.target.value as 'en-US' | 'si-LK')}
                title="Voice Microphone Recognition Language"
              >
                <option value="en-US">🎙️ EN/Singlish</option>
                <option value="si-LK">🎙️ සිංහල</option>
              </select>

              <button
                type="button"
                className={`mic-btn ${recording ? 'recording' : ''}`}
                onClick={toggleVoiceMic}
                title="Speak via Microphone"
              >
                🎤
              </button>

              <textarea
                className="composer-input"
                rows={1}
                placeholder="Talk like a human in Singlish, සිංහල, or English... (Enter to send, Shift+Enter for newline)"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />

              <button type="submit" className="send-btn" disabled={sending || !input.trim()}>
                {sending ? 'Thinking...' : 'Send ➤'}
              </button>
            </form>
          </section>

          <CorticalHeatmap
            cortex64={cortex64}
            limbic={limbic}
            onTriggerSleep={handleTriggerSleep}
            sleeping={sleeping}
          />
        </div>
      )}

      {/* Tab 2: Memory Vault & Knowledge Graph */}
      {activeTab === 'vault' && (
        <MemoryVaultView
          memories={memories}
          graph={graph}
          onSearchMemories={handleSearchMemories}
          onAddExplicitMemory={handleAddExplicitMemory}
          onReinforceMemory={handleReinforceMemory}
          onDeleteMemory={handleDeleteMemory}
          onTriggerSleep={handleTriggerSleep}
          sleeping={sleeping}
        />
      )}

      {/* Tab 3: Neural Cortex Lab */}
      {activeTab === 'lab' && (
        <NeuralLabView
          stats={stats}
          onRunEpochs={handleRunEpochs}
          onTeachSample={handleTeachSample}
          onProbe={handleProbe}
        />
      )}

      {/* Tab 4: Architecture & API */}
      {activeTab === 'architecture' && (
        <ArchitectureView
          stats={stats}
          externalSettings={externalSettings}
          onSaveExternalSettings={handleSaveExternalSettings}
        />
      )}
    </div>
  );
}
