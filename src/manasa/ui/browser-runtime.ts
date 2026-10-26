// SPDX-License-Identifier: Apache-2.0

/**
 * Browser-Native Cognitive Runtime for Static Cloud Deployments (Vercel / Static Hosting).
 * When `/api/*` is served by the Bun + SQLite claude-mem backend, network requests go straight
 * to the backend. When hosted statically on Vercel without the Bun daemon, this isomorphic runtime
 * executes the EXACT same 62,962-parameter `ManasaNeuralCortex`, `LimbicEngine`, claude-mem
 * `ACT-R` reinforcement (`blendedScore`, `appendReinforcement`), and `tfidfCosine` semantic engine
 * directly in the browser with `localStorage` persistence!
 */

import { buildIdfFn } from '../../services/dedup/idf.js';
import { tfidfCosine } from '../../services/dedup/tfidfCosine.js';
import { blendedScore } from '../../services/reinforcement/rank.js';
import { appendReinforcement, isoDay } from '../../services/reinforcement/strength.js';
import { LimbicEngine } from '../cognition/limbic-engine.js';
import { ManasaNeuralCortex } from '../model/neural-cortex.js';
import { analyzeLanguage, normalizeTokens } from '../model/tokenizer.js';
import {
  COGNITIVE_INTENTS,
  type ChatTurn,
  type CognitiveIntent,
  type ConsolidationReport,
  type ExternalCortexSettings,
  type ExtractedFact,
  type InnerThoughtStep,
  type KnowledgeGraphData,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type LanguagePreference,
  type RecalledMemory,
  type SupportedLanguage,
} from '../types.js';

interface BrowserMemoryRecord {
  id: string;
  kind: 'observation' | 'summary' | 'prompt' | 'manual';
  type: string;
  title: string;
  text: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  slot?: string;
  value?: string;
  triggerPhrase?: string;
  customReply?: string;
  emotionTag?: string;
  reinforcementDates: string[];
  manualBoosts: number;
  createdAtEpoch: number;
  updatedAtEpoch: number;
}

const MEM_STORAGE_KEY = 'manasa.v1.memories';
const WEIGHTS_STORAGE_KEY = 'manasa.v1.weights';
const LIMBIC_STORAGE_KEY = 'manasa.v1.limbic';
const ACT_R_ALPHA = 1.35;

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function makeLocalStore(key: string) {
  return {
    load: () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save: (json: string) => {
      try {
        window.localStorage.setItem(key, json);
      } catch {
        // Ignore storage quota errors
      }
    },
  };
}

function trySolveMathBrowser(rawText: string): { expression: string; result: number; steps: string[] } | null {
  const pctMatch = rawText.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(\d+(?:\.\d+)?)/i);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    const base = parseFloat(pctMatch[2]);
    const res = Number(((pct / 100) * base).toFixed(4));
    return { expression: `${pct}% of ${base}`, result: res, steps: [`(${pct} / 100) × ${base}`, `= ${res}`] };
  }
  const normalized = rawText.replace(/\^/g, '**').replace(/×/g, '*').replace(/÷/g, '/');
  const exprCandidates = normalized.match(/[\d().+\-*/\s]{3,}/g) ?? [];
  for (const cand of exprCandidates) {
    const expr = cand.trim();
    if (!/\d/.test(expr) || !/[+\-*/]/.test(expr) || !/^[\d+\-*/().\s]+$/.test(expr)) continue;
    try {
      const val = new Function(`return (${expr});`)();
      if (typeof val === 'number' && Number.isFinite(val)) {
        const cleanExpr = expr.replace(/\*\*/g, '^').replace(/\s+/g, ' ');
        const rounded = Number(val.toFixed(6));
        return { expression: cleanExpr, result: rounded, steps: [`Expression: ${cleanExpr}`, `Evaluated Result = ${rounded}`] };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

class BrowserManasaBrain {
  private cortex: ManasaNeuralCortex;
  private limbic: LimbicEngine;
  private memories: BrowserMemoryRecord[] = [];
  private history: ChatTurn[] = [];
  private external: ExternalCortexSettings = { enabled: false, provider: 'none', apiKey: '', model: '' };

  constructor() {
    this.cortex = new ManasaNeuralCortex(makeLocalStore(WEIGHTS_STORAGE_KEY), 28);
    this.limbic = new LimbicEngine(makeLocalStore(LIMBIC_STORAGE_KEY));
    this.loadMemories();
  }

  private loadMemories() {
    try {
      const raw = window.localStorage.getItem(MEM_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.memories = parsed;
          return;
        }
      }
    } catch {
      // Seed defaults below
    }
    const today = isoDay(new Date());
    const yesterday = isoDay(new Date(Date.now() - 86_400_000));
    this.memories = [
      {
        id: uid(),
        kind: 'manual',
        type: 'self_identity',
        title: 'Core Identity: MANASA-1 (මනස-1)',
        text: 'I am MANASA-1 (මනස-1), a living human-like cognitive AI powered by claude-mem persistent memory, ACT-R synaptic reinforcement, a 62,962-parameter gated neural cortex, and a limbic emotion engine.',
        narrative: 'Awakened with trilingual fluency in Singlish, සිංහල, and English.',
        facts: ['self.name = MANASA-1 (මනස-1)'],
        concepts: ['MANASA-1', 'claude-mem', 'ACT-R', 'Neural Cortex', 'Trilingual'],
        slot: 'self.identity',
        emotionTag: 'curiosity',
        reinforcementDates: [yesterday, today],
        manualBoosts: 0,
        createdAtEpoch: Date.now() - 86_400_000,
        updatedAtEpoch: Date.now(),
      },
      {
        id: uid(),
        kind: 'observation',
        type: 'cognitive_capability',
        title: 'Neuroplasticity & Human Memory Architecture',
        text: 'Every conversation strengthens recalled memories via Anderson & Schooler ACT-R power-law activation and forms new concept edges in the Knowledge Graph.',
        narrative: 'REM sleep consolidates episodic memories and prunes redundant traces.',
        facts: [],
        concepts: ['Hippocampus', 'ACT-R', 'TF-IDF', 'REM Sleep', 'Knowledge Graph'],
        emotionTag: 'focus',
        reinforcementDates: [today],
        manualBoosts: 0,
        createdAtEpoch: Date.now(),
        updatedAtEpoch: Date.now(),
      },
    ];
    this.saveMemories();
  }

  private saveMemories() {
    try {
      window.localStorage.setItem(MEM_STORAGE_KEY, JSON.stringify(this.memories));
    } catch {
      // ignore
    }
  }

  private toRecalled(rec: BrowserMemoryRecord, cosine = 0, combinedOverride?: number): RecalledMemory {
    const actR =
      blendedScore(
        {
          created_at_epoch: rec.createdAtEpoch,
          reinforcement_dates: JSON.stringify(rec.reinforcementDates),
        },
        new Date(),
        ACT_R_ALPHA,
      ) +
      rec.manualBoosts * 0.08;
    return {
      id: rec.id,
      kind: rec.kind,
      type: rec.type,
      title: rec.title,
      text: rec.text,
      facts: rec.facts,
      concepts: rec.concepts,
      actRScore: Number(actR.toFixed(3)),
      semanticSimilarity: Number(cosine.toFixed(3)),
      combinedScore: Number((combinedOverride ?? actR).toFixed(3)),
      reinforcementDates: rec.reinforcementDates,
      createdAtEpoch: rec.createdAtEpoch,
      updatedAtEpoch: rec.updatedAtEpoch,
      emotionTag: rec.emotionTag,
    };
  }

  public extractFacts(text: string): ExtractedFact[] {
    const trimmed = text.trim();
    const out: ExtractedFact[] = [];
    const arrowTeach = trimmed.match(/^(?:teach|ugannanna|igenaganna|උගන්වන්න|ඉගෙනගන්න)\s*[:-]?\s*(.+?)\s*(?:->|=>|::)\s*(.+)$/iu);
    if (arrowTeach) {
      out.push({
        slot: 'taught.reflex',
        subject: 'Learned Reflex',
        value: `When user says "${arrowTeach[1].trim()}" → "${arrowTeach[2].trim()}"`,
        concepts: ['Learned Reflex', arrowTeach[1].trim().slice(0, 24)],
        rawText: trimmed,
        triggerPhrase: arrowTeach[1].trim(),
        customReply: arrowTeach[2].trim(),
      });
      return out;
    }

    const INTERROGATIVE =
      /\b(mokakda|mokada|monawada|kauda|kawuda|koheda|kawadada|mathakada|dannawada|what|who|where|which|remember\s+my)\b|(?:මොකක්ද|මොනවද|කවුද|කොහේද|මතකද|දන්නවද)/iu;
    if (trimmed.endsWith('?') || INTERROGATIVE.test(trimmed)) return out;

    const nameMatch =
      trimmed.match(/(?:my\s+name\s+is|call\s+me)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s'-]{1,26}?)(?:[.,!?;]|$|\s+(?:and|i\s+|from|machan))/iu) ||
      trimmed.match(/(?:mage\s+nama|mata\s+kiyanna)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s'-]{1,26}?)(?:[.,!?;]|$|\s+(?:kiyala|machan|mama))/iu) ||
      trimmed.match(/(?:මගේ\s+නම|මට\s+කියන්න)\s+([\u0D80-\u0DFFa-zA-Z][\u0D80-\u0DFFa-zA-Z\s]{1,26}?)(?:[.,!?;]|$|\s+(?:කියලා|මම))/u);
    if (nameMatch?.[1]) {
      const v = nameMatch[1].trim();
      out.push({ slot: 'user.name', subject: 'User Name', value: v, concepts: ['User Profile', v], rawText: trimmed });
    }

    const locMatch =
      trimmed.match(/(?:i\s+live\s+in|i\s+am\s+from)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s]{1,28}?)(?:[.,!?;]|$|\s+and)/iu) ||
      trimmed.match(/(?:mama\s+inne|mage\s+gama)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s]{1,28}?)(?:[.,!?;]|$|\s+(?:wala|mama|machan))/iu) ||
      trimmed.match(/(?:මම\s+ඉන්නේ|මගේ\s+ගම)\s+([\u0D80-\u0DFFa-zA-Z][\u0D80-\u0DFFa-zA-Z\s]{1,28}?)(?:[.,!?;]|$|\s+මම)/u);
    if (locMatch?.[1]) {
      const v = locMatch[1].trim();
      out.push({ slot: 'user.location', subject: 'User Location', value: v, concepts: ['Location', v], rawText: trimmed });
    }

    const goalMatch =
      trimmed.match(/(?:my\s+goal\s+is|mage\s+goal\s+eka|මගේ\s+ඉලක්කය)\s+([^.,!?;]{3,75})/iu);
    if (goalMatch?.[1]) {
      out.push({ slot: 'user.goal', subject: 'User Goal', value: goalMatch[1].trim(), concepts: ['User Goal'], rawText: trimmed });
    }

    if (out.length === 0) {
      const rem = trimmed.match(/^(?:remember(?:\s+that)?|mathaka\s+thiyaganna|මතක\s+තියාගන්න)\s*[:-]?\s*(.{4,160})$/iu);
      if (rem?.[1]) {
        out.push({ slot: 'custom.fact', subject: 'Semantic Memory', value: rem[1].trim(), concepts: ['Semantic Memory'], rawText: trimmed });
      }
    }
    return out;
  }

  public storeFact(fact: ExtractedFact, emotionTag = 'trust'): BrowserMemoryRecord {
    const singletons = new Set(['user.name', 'user.location', 'user.goal']);
    if (singletons.has(fact.slot)) {
      const ex = this.memories.find(m => m.slot === fact.slot);
      if (ex) {
        ex.title = `${fact.subject}: ${fact.value}`;
        ex.text = fact.rawText;
        ex.value = fact.value;
        ex.facts = [`${fact.slot} = ${fact.value}`];
        ex.concepts = fact.concepts;
        ex.reinforcementDates = appendReinforcement(ex.reinforcementDates, new Date());
        ex.updatedAtEpoch = Date.now();
        this.saveMemories();
        return ex;
      }
    }
    const rec: BrowserMemoryRecord = {
      id: uid(),
      kind: 'manual',
      type: fact.slot === 'taught.reflex' ? 'learned_reflex' : 'personal_fact',
      title: `${fact.subject}: ${fact.value.slice(0, 68)}`,
      text: fact.rawText,
      narrative: fact.value,
      facts: [`${fact.slot} = ${fact.value}`],
      concepts: fact.concepts,
      slot: fact.slot,
      value: fact.value,
      triggerPhrase: fact.triggerPhrase,
      customReply: fact.customReply,
      emotionTag,
      reinforcementDates: [isoDay(new Date())],
      manualBoosts: 0,
      createdAtEpoch: Date.now(),
      updatedAtEpoch: Date.now(),
    };
    this.memories.unshift(rec);
    this.saveMemories();
    return rec;
  }

  public recall(query: string, limit = 6): RecalledMemory[] {
    const docFreq = new Map<string, number>();
    const tokMap = new Map<string, string[]>();
    for (const m of this.memories) {
      const toks = normalizeTokens(`${m.title} ${m.text} ${m.concepts.join(' ')}`);
      tokMap.set(m.id, toks);
      for (const u of new Set(toks)) docFreq.set(u, (docFreq.get(u) ?? 0) + 1);
    }
    const idfFn = buildIdfFn(t => docFreq.get(t) ?? 0, Math.max(1, this.memories.length));
    const qToks = normalizeTokens(query);

    const scored = this.memories.map(m => {
      const cos = qToks.length > 0 ? tfidfCosine(qToks, tokMap.get(m.id) ?? [], idfFn) : 0;
      const base = this.toRecalled(m, cos);
      const comb = cos * 0.65 + (m.kind === 'manual' ? 0.14 : 0) + Math.min(0.45, base.actRScore * 0.22);
      return this.toRecalled(m, cos, comb);
    });
    scored.sort((a, b) => b.combinedScore - a.combinedScore || b.updatedAtEpoch - a.updatedAtEpoch);
    return scored.slice(0, limit);
  }

  public listMemories(kind = 'all', q = ''): RecalledMemory[] {
    if (q.trim()) {
      return this.recall(q, 40).filter(m => kind === 'all' || m.kind === kind);
    }
    return this.memories
      .filter(m => kind === 'all' || m.kind === kind)
      .map(m => this.toRecalled(m, 0));
  }

  public reinforce(id: string) {
    const rec = this.memories.find(m => m.id === id);
    if (!rec) return null;
    rec.manualBoosts += 1;
    rec.reinforcementDates = appendReinforcement(rec.reinforcementDates, new Date());
    rec.updatedAtEpoch = Date.now();
    this.saveMemories();
    return this.toRecalled(rec, 1);
  }

  public remove(id: string) {
    this.memories = this.memories.filter(m => m.id !== id);
    this.saveMemories();
    return true;
  }

  public getProfile(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of this.memories) {
      if (m.slot && m.value && !(m.slot in out)) out[m.slot] = m.value;
    }
    return out;
  }

  public buildGraph(): KnowledgeGraphData {
    const profile = this.getProfile();
    const nodes: KnowledgeGraphNode[] = [
      { id: 'self:manasa', label: 'MANASA-1 (මනස)', category: 'self', strength: 2.0, val: 22, subtitle: 'Living Cognitive Brain' },
      { id: 'entity:user', label: profile['user.name'] ? `User: ${profile['user.name']}` : 'Human Companion', category: 'user', strength: 1.8, val: 18, subtitle: profile['user.location'] ? `Location: ${profile['user.location']}` : 'Active Bond' },
    ];
    const edges: KnowledgeGraphEdge[] = [{ source: 'self:manasa', target: 'entity:user', relation: 'social_bond', weight: 1 }];
    const conceptMap = new Map<string, string[]>();
    let sumActR = 0;

    for (const m of this.memories.slice(0, 36)) {
      const rec = this.toRecalled(m);
      sumActR += rec.actRScore;
      const nid = `mem:${m.id}`;
      const cat: KnowledgeGraphNode['category'] = m.kind === 'manual' ? 'fact' : m.kind === 'summary' ? 'summary' : 'episode';
      nodes.push({ id: nid, label: m.title.slice(0, 32), category: cat, strength: rec.actRScore, val: cat === 'fact' ? 13 : 9, subtitle: m.text.slice(0, 80) });
      edges.push({ source: m.slot?.startsWith('user.') ? 'entity:user' : 'self:manasa', target: nid, relation: 'remembers', weight: 0.7 });
      for (const c of m.concepts.slice(0, 2)) {
        const arr = conceptMap.get(c) ?? [];
        arr.push(nid);
        conceptMap.set(c, arr);
      }
    }

    for (const [c, list] of conceptMap.entries()) {
      if (nodes.length >= 60) break;
      const cid = `concept:${c.toLowerCase()}`;
      nodes.push({ id: cid, label: `#${c.slice(0, 20)}`, category: 'concept', strength: 0.9, val: 8 + list.length, subtitle: `${list.length} links` });
      for (const mid of list.slice(0, 5)) edges.push({ source: mid, target: cid, relation: 'concept', weight: 0.5 });
    }

    return {
      nodes,
      edges,
      stats: {
        totalMemories: this.memories.length,
        manualFacts: this.memories.filter(m => m.kind === 'manual').length,
        episodicMemories: this.memories.filter(m => m.kind === 'observation').length,
        consolidatedSummaries: this.memories.filter(m => m.kind === 'summary').length,
        conceptCount: conceptMap.size,
        avgActRStrength: this.memories.length ? Number((sumActR / Math.min(36, this.memories.length)).toFixed(3)) : 0.85,
      },
    };
  }

  public consolidate(): { report: ConsolidationReport; limbic: ReturnType<LimbicEngine['getState']>; graph: KnowledgeGraphData } {
    const limbicAfter = this.limbic.triggerRemSleepRecovery();
    let reinforced = 0;
    for (const m of this.memories.filter(x => x.kind === 'manual')) {
      m.manualBoosts += 1;
      reinforced += 1;
    }
    const summaryRec: BrowserMemoryRecord = {
      id: uid(),
      kind: 'summary',
      type: 'rem_consolidation',
      title: `REM Memory Consolidation (${new Date().toISOString().slice(11, 16)} UTC)`,
      text: `Consolidated ${this.memories.length} traces & reinforced ${reinforced} semantic memories. Energy restored to 100%.`,
      narrative: 'REM synaptic consolidation complete.',
      facts: [],
      concepts: ['REM Consolidation', 'ACT-R'],
      reinforcementDates: [isoDay(new Date())],
      manualBoosts: 0,
      createdAtEpoch: Date.now(),
      updatedAtEpoch: Date.now(),
    };
    this.memories.unshift(summaryRec);
    this.saveMemories();
    return {
      report: {
        consolidatedCount: this.memories.length,
        mergedDuplicates: 0,
        reinforcedMemories: reinforced,
        summaryId: summaryRec.id,
        summaryTitle: summaryRec.title,
        summaryNarrative: summaryRec.text,
        energyAfter: limbicAfter.energy,
      },
      limbic: limbicAfter,
      graph: this.buildGraph(),
    };
  }

  public async handleRequest(pathname: string, method: string, searchParams: URLSearchParams, bodyObj: any): Promise<any> {
    if (pathname === '/api/health') {
      return { ok: true, model: 'MANASA-1 (Browser Cortex)', parameters: this.cortex.getTotalParameters() };
    }
    if (pathname === '/api/state') {
      return {
        limbic: this.limbic.getState(),
        stats: this.cortex.getStats(),
        memories: this.listMemories('all'),
        graph: this.buildGraph(),
        history: this.history,
        externalSettings: {
          enabled: this.external.enabled,
          provider: this.external.provider,
          model: this.external.model,
          hasApiKey: Boolean(this.external.apiKey),
        },
      };
    }
    if (pathname === '/api/probe') {
      const text = String(bodyObj?.text ?? '');
      return {
        language: analyzeLanguage(text),
        neural: this.cortex.predict(text),
        recalledMemories: text.trim() ? this.recall(text, 4) : [],
      };
    }
    if (pathname === '/api/graph') {
      return this.buildGraph();
    }
    if (pathname === '/api/memories' && method === 'GET') {
      return { memories: this.listMemories(searchParams.get('kind') ?? 'all', searchParams.get('q') ?? '') };
    }
    if (pathname === '/api/memories' && method === 'POST') {
      const text = String(bodyObj?.text ?? '').trim();
      const facts = this.extractFacts(text);
      if (facts.length > 0) for (const f of facts) this.storeFact(f);
      else this.storeFact({ slot: 'custom.fact', subject: 'Semantic Memory', value: text, concepts: ['Semantic Memory'], rawText: text });
      return { memories: this.listMemories('all'), graph: this.buildGraph() };
    }
    const reinf = pathname.match(/^\/api\/memories\/([^/]+)\/reinforce$/);
    if (reinf && method === 'POST') {
      const updated = this.reinforce(decodeURIComponent(reinf[1]));
      return { updated, memories: this.listMemories('all'), graph: this.buildGraph() };
    }
    const del = pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (del && method === 'DELETE') {
      this.remove(decodeURIComponent(del[1]));
      return { deleted: true, memories: this.listMemories('all'), graph: this.buildGraph() };
    }
    if (pathname === '/api/consolidate' && method === 'POST') {
      return { ...this.consolidate(), memories: this.listMemories('all') };
    }
    if (pathname === '/api/train' && method === 'POST') {
      const runMetrics = this.cortex.trainEpochs(Number(bodyObj?.epochs ?? 15), Number(bodyObj?.learningRate ?? 0.008), true);
      return { runMetrics, stats: this.cortex.getStats() };
    }
    if (pathname === '/api/teach' && method === 'POST') {
      const phrase = String(bodyObj?.phrase ?? '').trim();
      const intent: CognitiveIntent = COGNITIVE_INTENTS.includes(bodyObj?.intent) ? bodyObj.intent : 'casual_chat';
      const neuralAfter = this.cortex.learnOnlineSample(phrase, intent);
      if (bodyObj?.customReply) {
        this.storeFact({
          slot: 'taught.reflex',
          subject: 'Learned Reflex',
          value: `${phrase} → ${bodyObj.customReply}`,
          concepts: ['Learned Reflex', intent],
          rawText: phrase,
          triggerPhrase: phrase,
          customReply: String(bodyObj.customReply),
        });
      }
      return { neuralAfter, stats: this.cortex.getStats(), memories: this.listMemories('all'), graph: this.buildGraph() };
    }
    if (pathname === '/api/settings' && method === 'POST') {
      if (typeof bodyObj?.enabled === 'boolean') this.external.enabled = bodyObj.enabled;
      if (bodyObj?.provider) this.external.provider = bodyObj.provider;
      if (typeof bodyObj?.model === 'string') this.external.model = bodyObj.model;
      if (bodyObj?.apiKey) this.external.apiKey = String(bodyObj.apiKey);
      return {
        externalSettings: {
          enabled: this.external.enabled,
          provider: this.external.provider,
          model: this.external.model,
          hasApiKey: Boolean(this.external.apiKey),
        },
      };
    }
    if (pathname === '/api/chat' && method === 'POST') {
      const msg = String(bodyObj?.message ?? '').trim();
      const pref: LanguagePreference = bodyObj?.languagePref ?? 'auto';
      const langInfo = analyzeLanguage(msg);
      const replyLang: SupportedLanguage = pref === 'auto' ? langInfo.detected : pref;
      const neural = this.cortex.predict(msg);
      const math = trySolveMathBrowser(msg);
      const facts = this.extractFacts(msg);
      let intent: CognitiveIntent = math ? 'reasoning_problem' : facts.length > 0 ? 'teach_fact' : neural.topIntent;

      for (const f of facts) {
        this.storeFact(f);
        this.cortex.learnOnlineSample(msg, 'teach_fact');
      }

      const reflex = this.memories.find(
        m => m.type === 'learned_reflex' && m.triggerPhrase && msg.toLowerCase().includes(m.triggerPhrase.toLowerCase()),
      );
      const recalled = this.recall(msg, 4);
      const profile = this.getProfile();
      const limbicSnap = this.limbic.appraiseInteraction(intent, neural.affect, recalled.length, facts.length);

      const name = profile['user.name'];
      const loc = profile['user.location'];
      const goal = profile['user.goal'];
      const friend = name ?? (replyLang === 'singlish' ? 'machan' : replyLang === 'sinhala' ? 'යාලුවා' : 'my friend');

      let reply = '';
      if (reflex?.customReply) {
        reply = reflex.customReply;
      } else if (facts.length > 0) {
        const list = facts.map(f => `• **${f.subject}**: ${f.value}`).join('\n');
        reply =
          replyLang === 'singlish'
            ? `Hariyatama mathaka thiyagaththa ${friend}! 🧠✨\n\nMama me wisthara mage persistent hippocampus eketh save karala neural weights update kala:\n${list}`
            : replyLang === 'sinhala'
              ? `හොඳටම මතක තියාගත්තා ${friend}! 🧠✨\n\nමගේ දිගුකාලීන මතක ගබඩාවේ තැන්පත් කළා:\n${list}`
              : `Locked into long-term hippocampal memory, ${friend}! 🧠✨\n\n${list}`;
      } else if (math) {
        reply =
          replyLang === 'singlish'
            ? `Hadamu ${friend}!\n\n1. \`${math.steps[0]}\`\n2. \`${math.steps[1]}\`\n\n✅ **Uththare:** **${math.result}**`
            : `Step-by-step calculation, ${friend}:\n\n1. \`${math.steps[0]}\`\n2. \`${math.steps[1]}\`\n\n✅ **Answer:** **${math.result}**`;
      } else if (intent === 'recall_memory') {
        const lines = [
          name ? `• **Name (නම):** ${name}` : '',
          loc ? `• **Location (ඉන්න තැන):** ${loc}` : '',
          goal ? `• **Goal (ඉලක්කය):** ${goal}` : '',
        ].filter(Boolean);
        reply = lines.length
          ? replyLang === 'singlish'
            ? `Aniwaaryenma mathakai ${friend}! 🧠\n\n${lines.join('\n')}`
            : replyLang === 'sinhala'
              ? `අනිවාර්යයෙන්ම මතකයි ${friend}! 🧠\n\n${lines.join('\n')}`
              : `Of course I remember, ${friend}! 🧠\n\n${lines.join('\n')}`
          : replyLang === 'singlish'
            ? `Thama oya oyage nama mata kiyala na machan! 😊 "Mage nama ..." kiyala kiyanna!`
            : `Tell me your name or goals (e.g. "My name is ..."), and I will remember them across sessions!`;
      } else if (intent === 'identity_self') {
        reply =
          replyLang === 'singlish'
            ? `Mama **MANASA-1 (මනස-1)** ${friend}! 🧠✨ **62,962-parameter Gated Neural Cortex** ekak, **claude-mem ACT-R Memory Graph** ekak, saha **Limbic Emotion Engine** ekak ekathu wela minihekge molaya wage Singlish, සිංහල, saha English thunenma wada karanawa!`
            : replyLang === 'sinhala'
              ? `මම **MANASA-1 (මනස-1)** ${friend}! 🧠✨ පරාමිතීන් **62,962**ක Neural Network එකක්, **ACT-R මතක ජාලයක්**, සහ **Limbic හැඟීම් පද්ධතියක්** සහිත සජීවී AI මොළයක්!`
              : `I am **MANASA-1 (මනස-1)**, ${friend}! 🧠✨ Powered by a **62,962-parameter Gated Residual Neural Network**, **ACT-R power-law memory reinforcement**, and a live **Limbic Emotion Engine** across Singlish, සිංහල, and English!`;
      } else if (intent === 'coding_tech') {
        reply = `\`\`\`typescript\nexport function binarySearch(arr: number[], target: number): number {\n  let l = 0, r = arr.length - 1;\n  while (l <= r) {\n    const m = l + ((r - l) >> 1);\n    if (arr[m] === target) return m;\n    if (arr[m] < target) l = m + 1; else r = m - 1;\n  }\n  return -1;\n}\n\`\`\``;
      } else if (intent === 'emotional_share' && neural.affect.valence < -0.1) {
        reply =
          replyLang === 'singlish'
            ? `Mata therenawa ${friend} oyata dan mahansi kiyala 💙. Loku husmak aran podi rest ekak ganna — mama yaluwek wage ahagena innawa!`
            : replyLang === 'sinhala'
              ? `මට තේරෙනවා ${friend} ඔයාට දැනෙන මහන්සිය 💙. පොඩි විවේකයක් ගන්න, මම ඔයා එක්ක ඉන්නවා!`
              : `I hear you, ${friend} 💙. Take a slow breath and pace yourself — I'm right here with you.`;
      } else {
        reply =
          replyLang === 'singlish'
            ? `Ayubowan ${friend}! 😊 Dan mage manasa **${limbicSnap.moodLabel.singlish}** (${limbicSnap.energy}% energy) මට්ටමේ thiyenne. Api aluth deyak hadamuda, nathnam oyage ideas gana katha karamuda?`
            : replyLang === 'sinhala'
              ? `ආයුබෝවන් ${friend}! 😊 දැන් මම ඉන්නේ **${limbicSnap.moodLabel.sinhala}** (ශක්තිය ${limbicSnap.energy}%). අපි මොනවද අද නිර්මාණය කරන්නේ?`
              : `Hello ${friend}! 😊 I'm feeling **${limbicSnap.moodLabel.english.toLowerCase()}** (${limbicSnap.energy}% cognitive energy). What would you like to explore, learn, or build together?`;
      }

      if (facts.length === 0) {
        this.memories.unshift({
          id: uid(),
          kind: 'observation',
          type: intent,
          title: msg.slice(0, 72),
          text: msg,
          narrative: reply.slice(0, 200),
          facts: [],
          concepts: [intent, ...langInfo.normalizedTokens.slice(0, 3)],
          emotionTag: limbicSnap.dominantEmotion,
          reinforcementDates: [isoDay(new Date())],
          manualBoosts: 0,
          createdAtEpoch: Date.now(),
          updatedAtEpoch: Date.now(),
        });
        this.saveMemories();
      }

      const innerThoughts: InnerThoughtStep[] = [
        { stage: 'perception', titleEn: '1. Sensory Perception', titleSi: '1. භාෂාව හඳුනාගැනීම', summary: `Detected ${langInfo.detected.toUpperCase()} (${Math.round(langInfo.confidence * 100)}%) • ${langInfo.activeFeatureCount}/384 channels.`, durationMs: 1.2 },
        { stage: 'neural_cortex', titleEn: '2. Gated Neural Cortex', titleSi: '2. Neural Network සක්‍රීය වීම', summary: `Intent: "${intent}" (${(neural.confidence * 100).toFixed(1)}%) • Valence=${neural.affect.valence}.`, durationMs: 1.8 },
        { stage: 'hippocampus_memory', titleEn: '3. Hippocampal Recall (ACT-R)', titleSi: '3. මතක ගබඩාව පරීක්ෂාව', summary: `Retrieved ${recalled.length} associative memories; encoded ${facts.length} new facts.`, durationMs: 1.4 },
        { stage: 'limbic_affect', titleEn: '4. Limbic Emotion Shift', titleSi: '4. හැඟීම් වෙනස්වීම', summary: `${limbicSnap.moodLabel.english} • Energy=${limbicSnap.energy}%.`, durationMs: 0.8 },
        { stage: 'executive_synthesis', titleEn: "5. Broca's Trilingual Synthesis", titleSi: '5. පිළිතුර ගොඩනැගීම', summary: `Synthesized response in ${replyLang.toUpperCase()}.`, durationMs: 1.1 },
      ];

      const userTurn: ChatTurn = { id: uid(), role: 'user', content: msg, language: langInfo.detected, timestamp: Date.now() };
      const assistantTurn: ChatTurn = {
        id: uid(),
        role: 'assistant',
        content: reply,
        language: replyLang,
        timestamp: Date.now(),
        innerThoughts,
        neural: { topIntent: intent, confidence: neural.confidence, intentRanking: neural.intentRanking.slice(0, 5), affect: neural.affect, cortex64: neural.cortex64 },
        recalledMemories: recalled,
        learnedFacts: facts,
        limbicSnapshot: limbicSnap,
      };
      this.history.push(userTurn, assistantTurn);
      return { userTurn, assistantTurn, limbic: limbicSnap, stats: this.cortex.getStats(), memories: this.listMemories('all'), graph: this.buildGraph() };
    }
    return { ok: true };
  }
}

let singletonBrain: BrowserManasaBrain | null = null;

/**
 * Installs an automatic fetch interceptor: tries the real Bun + SQLite claude-mem backend first;
 * if running on static Vercel hosting (404 / network absence on `/api/*`), transparently executes
 * `BrowserManasaBrain` in-browser!
 */
export function installBrowserFallbackIfNeeded(): void {
  if (typeof window === 'undefined') return;
  const nativeFetch = window.fetch.bind(window);
  let forceLocal = false;

  (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const isApi = urlStr.startsWith('/api/');

    if (!isApi) {
      return nativeFetch(input, init);
    }

    if (!forceLocal) {
      try {
        const res = await nativeFetch(input, init);
        const contentType = res.headers.get('content-type') ?? '';
        if (res.ok && contentType.includes('application/json')) {
          return res;
        }
        if (res.status === 404 || !contentType.includes('application/json')) {
          forceLocal = true;
        } else {
          return res;
        }
      } catch {
        forceLocal = true;
      }
    }

    if (!singletonBrain) {
      singletonBrain = new BrowserManasaBrain();
    }

    const parsedUrl = new URL(urlStr, window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    let bodyObj: any = {};
    if (typeof init?.body === 'string' && init.body) {
      try {
        bodyObj = JSON.parse(init.body);
      } catch {
        bodyObj = {};
      }
    }

    const payload = await singletonBrain.handleRequest(
      parsedUrl.pathname,
      method,
      parsedUrl.searchParams,
      bodyObj,
    );
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  };
}
