// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { ManasaHippocampus } from '../memory/hippocampus.js';
import { ManasaNeuralCortex, type PersistenceAdapter } from '../model/neural-cortex.js';
import { analyzeLanguage } from '../model/tokenizer.js';
import type {
  ChatTurn,
  CognitiveIntent,
  ConsolidationReport,
  ExternalCortexSettings,
  InnerThoughtStep,
  KnowledgeGraphData,
  LanguagePreference,
  LimbicState,
  NeuralForwardResult,
  NeuralModelStats,
  RecalledMemory,
  SupportedLanguage,
} from '../types.js';
import { LimbicEngine } from './limbic-engine.js';

/**
 * Safe mathematical expression evaluator (supports +, -, *, /, %, ^, **, parentheses, percentages).
 */
function trySolveMath(rawText: string): { expression: string; result: number; steps: string[] } | null {
  const steps: string[] = [];

  // Percentage pattern: "15% of 4800" or "4800න් 15%"
  const pctMatch = rawText.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s*)?(\d+(?:\.\d+)?)/i);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    const base = parseFloat(pctMatch[2]);
    const res = Number(((pct / 100) * base).toFixed(4));
    steps.push(`(${pct} / 100) × ${base} = ${pct / 100} × ${base}`);
    steps.push(`= ${res}`);
    return { expression: `${pct}% of ${base}`, result: res, steps };
  }

  // Speed × time word problem (e.g. "80km ... 3.5")
  const speedMatch = rawText.match(/(\d+(?:\.\d+)?)\s*km.*?(?:paya|hours?|hrs?)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:km\/h|kmph).*?(\d+(?:\.\d+)?)/i);
  if (speedMatch) {
    const a = parseFloat(speedMatch[1] ?? speedMatch[3]);
    const b = parseFloat(speedMatch[2] ?? speedMatch[4]);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      const dist = Number((a * b).toFixed(4));
      steps.push(`Distance = Speed × Time = ${a} × ${b}`);
      steps.push(`= ${dist} km`);
      return { expression: `${a} × ${b}`, result: dist, steps };
    }
  }

  // General arithmetic expression extraction
  const normalized = rawText.replace(/\^/g, '**').replace(/×/g, '*').replace(/÷/g, '/');
  const exprCandidates = normalized.match(/[\d().+\-*/\s]{3,}/g) ?? [];
  for (const cand of exprCandidates) {
    const expr = cand.trim();
    if (!/\d/.test(expr) || !/[+\-*/]/.test(expr)) continue;
    if (!/^[\d+\-*/().\s]+$/.test(expr)) continue;
    try {
      // Validated character-only whitelist above: digits, operators, parens, whitespace
      const fn = new Function(`return (${expr});`);
      const val = fn();
      if (typeof val === 'number' && Number.isFinite(val)) {
        const cleanExpr = expr.replace(/\*\*/g, '^').replace(/\s+/g, ' ');
        const rounded = Number(val.toFixed(6));
        steps.push(`Expression: ${cleanExpr}`);
        steps.push(`Evaluated Result = ${rounded}`);
        return { expression: cleanExpr, result: rounded, steps };
      }
    } catch {
      // Not a valid arithmetic subexpression
    }
  }
  return null;
}

function generateCodeSnippet(text: string, lang: SupportedLanguage): string {
  const lower = text.toLowerCase();

  if (lower.includes('binary search')) {
    const code = `\`\`\`typescript
export function binarySearch(sorted: number[], target: number): number {
  let low = 0;
  let high = sorted.length - 1;

  while (low <= high) {
    const mid = low + ((high - low) >> 1);
    if (sorted[mid] === target) return mid;
    if (sorted[mid] < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
\`\`\``;
    if (lang === 'singlish') {
      return `Menna clean **O(log n) Binary Search** implementation ekak TypeScript walin:\n\n${code}\n\nMeke \`(high - low) >> 1\` pawichchi karala thiyenne integer overflow eka nawathwanna saha array eka deka gane bedala ikmanatama target eka hoyaganna!`;
    }
    if (lang === 'sinhala') {
      return `මෙන්න පිරිසිදු **O(log n) Binary Search** TypeScript කේතය:\n\n${code}\n\nමෙහිදී පිළිවෙලට සකස් කළ (sorted) දත්ත පෙළක් මැදින් දෙකට බෙදමින් ඉතා වේගයෙන් අවශ්‍ය අගය සොයා ගනී.`;
    }
    return `Here is a clean, production-ready **O(log n) Binary Search** implementation in TypeScript:\n\n${code}\n\nIt halves the search interval on every iteration, scaling effortlessly to millions of elements.`;
  }

  if (lower.includes('python') || lower.includes('neural')) {
    const code = `\`\`\`python
import math

class DenseLayer:
    def __init__(self, in_dim: int, out_dim: int):
        scale = math.sqrt(2.0 / (in_dim + out_dim))
        self.W = [[(i * 17 % 19 - 9) * 0.05 * scale for i in range(in_dim)] for _ in range(out_dim)]
        self.b = [0.0] * out_dim

    def forward(self, x: list[float]) -> list[float]:
        out = []
        for r in range(len(self.W)):
            z = sum(w * xi for w, xi in zip(self.W[r], x)) + self.b[r]
            out.append(math.tanh(z))  # Non-linear cortical activation
        return out
\`\`\``;
    if (lang === 'singlish') {
      return `Menna Python walin scratch indan liyapu **Neural Dense Layer** code ekak (mage neural cortex eketh me wage layers wada karanne!):\n\n${code}`;
    }
    if (lang === 'sinhala') {
      return `මෙන්න Python භාවිතයෙන් මුල සිට නිර්මාණය කළ **Neural Network Layer** කේතයක්:\n\n${code}`;
    }
    return `Here is a clean from-scratch **Python Neural Dense Layer** with Xavier scaling and \`tanh\` activation:\n\n${code}`;
  }

  if (lower.includes('sql') || lower.includes('fts')) {
    const code = `\`\`\`sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
  memory_item_id UNINDEXED,
  title,
  text,
  facts,
  concepts,
  tokenize = 'porter unicode61'
);

SELECT memory_item_id, bm25(memory_items_fts) AS rank
FROM memory_items_fts
WHERE memory_items_fts MATCH '"neural" OR "memory"'
ORDER BY rank LIMIT 10;
\`\`\``;
    return lang === 'singlish'
      ? `Menna mage \`claude-mem\` hippocampus eketh pawichchi karana **SQLite FTS5** full-text search query eka:\n\n${code}`
      : lang === 'sinhala'
        ? `මෙන්න මගේ \`claude-mem\` මතක ගබඩාවේ භාවිතා වන **SQLite FTS5** සෙවුම් කේතය:\n\n${code}`
        : `Here is the exact **SQLite FTS5** full-text indexing & BM25 retrieval pattern used in \`claude-mem\`:\n\n${code}`;
  }

  const code = `\`\`\`typescript
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
\`\`\``;
  return lang === 'singlish'
    ? `Menna oyata clean **TypeScript Vector Cosine Similarity** code ekak (semantic memory search walata supiriyatama galapenawa):\n\n${code}`
    : lang === 'sinhala'
      ? `මෙන්න පිරිසිදු **TypeScript Cosine Similarity** කේතයක් (මතක සමානතාවය මැනීමට ඉතාමත් ප්‍රයෝජනවත්):\n\n${code}`
      : `Here is a clean, dependency-free **TypeScript Cosine Similarity** utility ideal for semantic vector comparison:\n\n${code}`;
}

export interface ManasaAgentOptions {
  dbPath?: string;
  checkpointPath?: string;
  limbicStatePath?: string;
}

export class ManasaCognitiveAgent {
  public readonly cortex: ManasaNeuralCortex;
  public readonly hippocampus: ManasaHippocampus;
  public readonly limbic: LimbicEngine;
  private conversationHistory: ChatTurn[] = [];
  private externalCortex: ExternalCortexSettings = {
    enabled: false,
    provider: 'none',
    apiKey: '',
    model: '',
  };

  constructor(options: ManasaAgentOptions = {}) {
    const makeFileStore = (filePath?: string): PersistenceAdapter | null =>
      filePath
        ? {
            load: () => (existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null),
            save: (json: string) => {
              mkdirSync(dirname(filePath), { recursive: true });
              writeFileSync(filePath, json);
            },
          }
        : null;

    this.cortex = new ManasaNeuralCortex(makeFileStore(options.checkpointPath));
    this.hippocampus = new ManasaHippocampus(options.dbPath ?? ':memory:');
    this.limbic = new LimbicEngine(makeFileStore(options.limbicStatePath));
  }

  public getConversationHistory(): ChatTurn[] {
    return this.conversationHistory;
  }

  public clearSessionConversation(): void {
    this.conversationHistory = [];
  }

  public getExternalSettings(): Omit<ExternalCortexSettings, 'apiKey'> & { hasApiKey: boolean } {
    return {
      enabled: this.externalCortex.enabled,
      provider: this.externalCortex.provider,
      model: this.externalCortex.model,
      hasApiKey: Boolean(this.externalCortex.apiKey),
    };
  }

  public updateExternalSettings(next: Partial<ExternalCortexSettings>) {
    if (typeof next.enabled === 'boolean') this.externalCortex.enabled = next.enabled;
    if (next.provider) this.externalCortex.provider = next.provider;
    if (typeof next.model === 'string') this.externalCortex.model = next.model;
    if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
      this.externalCortex.apiKey = next.apiKey.trim();
    }
    return this.getExternalSettings();
  }

  public probeUtterance(text: string): {
    language: ReturnType<typeof analyzeLanguage>;
    neural: NeuralForwardResult;
    recalledMemories: RecalledMemory[];
  } {
    const language = analyzeLanguage(text);
    const neural = this.cortex.predict(text);
    const recalledMemories = text.trim() ? this.hippocampus.recallMemories(text, 4, false) : [];
    return { language, neural, recalledMemories };
  }

  public teachExplicit(input: {
    phrase: string;
    intent: CognitiveIntent;
    customReply?: string;
  }) {
    const lang = analyzeLanguage(input.phrase).detected;
    const neuralAfter = this.cortex.learnOnlineSample(input.phrase, input.intent, undefined, lang);
    let storedFact = null;
    if (input.customReply && input.customReply.trim()) {
      storedFact = this.hippocampus.storeFact(
        {
          slot: 'taught.reflex',
          subject: 'Learned Reflex',
          value: `When user says "${input.phrase}" → "${input.customReply.trim()}"`,
          concepts: ['Learned Reflex', input.intent],
          rawText: input.phrase,
          triggerPhrase: input.phrase,
          customReply: input.customReply.trim(),
        },
        'curiosity',
      );
    } else {
      storedFact = this.hippocampus.storeFact(
        {
          slot: 'custom.fact',
          subject: `Taught (${input.intent})`,
          value: input.phrase,
          concepts: ['Neural Training', input.intent],
          rawText: input.phrase,
        },
        'curiosity',
      );
    }

    return {
      neuralAfter,
      storedMemoryId: storedFact.id,
      stats: this.cortex.getStats(),
    };
  }

  public runRemConsolidation(): { report: ConsolidationReport; limbic: LimbicState; graph: KnowledgeGraphData } {
    const limbicAfter = this.limbic.triggerRemSleepRecovery();
    const report = this.hippocampus.consolidateRemSleep(limbicAfter.energy);
    return {
      report,
      limbic: limbicAfter,
      graph: this.hippocampus.buildKnowledgeGraph(),
    };
  }

  /**
   * Executes the full 5-Stage Human Cognitive Pipeline on a user message!
   */
  public async chat(
    message: string,
    languagePref: LanguagePreference = 'auto',
  ): Promise<{ userTurn: ChatTurn; assistantTurn: ChatTurn; limbic: LimbicState; stats: NeuralModelStats }> {
    const trimmed = message.trim();
    const innerThoughts: InnerThoughtStep[] = [];

    // STAGE 1: Sensory & Language Perception
    const t0 = performance.now();
    const langInfo = analyzeLanguage(trimmed);
    const replyLang: SupportedLanguage =
      languagePref === 'auto' ? langInfo.detected : languagePref;
    const d1 = Math.max(1, Number((performance.now() - t0).toFixed(2)));

    innerThoughts.push({
      stage: 'perception',
      titleEn: '1. Sensory & Linguistic Perception',
      titleSi: '1. භාෂාව සහ සංවේදී හඳුනාගැනීම',
      summary: `Detected ${langInfo.detected.toUpperCase()} (${Math.round(langInfo.confidence * 100)}% conf) • ${langInfo.normalizedTokens.length} tokens → ${langInfo.activeFeatureCount}/384 active cortical input channels. Reply language: ${replyLang.toUpperCase()}.`,
      metrics: {
        detected: langInfo.detected,
        replyMode: replyLang,
        tokens: langInfo.normalizedTokens.length,
        activeChannels: langInfo.activeFeatureCount,
      },
      durationMs: d1,
    });

    // STAGE 2: Neural Cortex Forward Pass
    const t1 = performance.now();
    const neural = this.cortex.predict(trimmed);
    // Boost intent override when explicit math expression or explicit personal fact pattern is present
    const mathSolution = trySolveMath(trimmed);
    const personalFacts = this.hippocampus.extractPersonalFacts(trimmed);

    let effectiveIntent: CognitiveIntent = neural.topIntent;
    if (mathSolution && effectiveIntent !== 'reasoning_problem') {
      effectiveIntent = 'reasoning_problem';
    } else if (personalFacts.length > 0 && effectiveIntent !== 'teach_fact') {
      effectiveIntent = 'teach_fact';
    }
    const d2 = Math.max(1, Number((performance.now() - t1).toFixed(2)));

    innerThoughts.push({
      stage: 'neural_cortex',
      titleEn: '2. Gated Neural Cortex Activation (62,962 params)',
      titleSi: '2. Neural Network ස්නායු සක්‍රීය වීම',
      summary: `Top intent: "${effectiveIntent}" (${(neural.confidence * 100).toFixed(1)}%, H=${neural.entropy} bits) • Affect appraisal: Valence=${neural.affect.valence >= 0 ? '+' : ''}${neural.affect.valence}, Warmth=${neural.affect.warmth}, Curiosity=${neural.affect.curiosity}.`,
      metrics: {
        intent: effectiveIntent,
        confidence: `${(neural.confidence * 100).toFixed(1)}%`,
        valence: neural.affect.valence,
        cortexNorm: neural.layerNorms.cortex64Norm,
      },
      durationMs: d2,
    });

    // STAGE 3: Hippocampal Memory Encoding & Recall (claude-mem)
    const t2 = performance.now();
    const matchedReflex =
      personalFacts.length === 0 ? this.hippocampus.findMatchingReflex(trimmed) : null;

    for (const fact of personalFacts) {
      this.hippocampus.storeFact(fact, 'trust');
      this.cortex.learnOnlineSample(trimmed, 'teach_fact', [0.72, 0.58, 0.88, 0.78], langInfo.detected);
    }

    const recalled = this.hippocampus.recallMemories(trimmed, 5, true);
    const userProfile = this.hippocampus.getUserProfileMap();
    const d3 = Math.max(1, Number((performance.now() - t2).toFixed(2)));

    innerThoughts.push({
      stage: 'hippocampus_memory',
      titleEn: '3. Hippocampal Recall & Encoding (claude-mem + ACT-R)',
      titleSi: '3. claude-mem මතක ගබඩාව පරීක්ෂාව සහ තැන්පත් කිරීම',
      summary:
        personalFacts.length > 0
          ? `Encoded ${personalFacts.length} new long-term memory fact(s) [${personalFacts.map(f => f.slot).join(', ')}] into SQLite FTS5 & updated online weights. Retrieved ${recalled.length} associative traces.`
          : `Queried claude-mem FTS5 + TF-IDF cosine + ACT-R decay: retrieved ${recalled.length} memories (top ACT-R strength=${recalled[0]?.actRScore ?? 0}).`,
      metrics: {
        recalledCount: recalled.length,
        newlyEncoded: personalFacts.length,
        topActR: recalled[0]?.actRScore ?? 0,
        knownUser: userProfile['user.name'] ?? 'friend',
      },
      durationMs: d3,
    });

    // STAGE 4: Limbic Emotional Appraisal
    const t3 = performance.now();
    const limbicSnapshot = this.limbic.appraiseInteraction(
      effectiveIntent,
      neural.affect,
      recalled.length,
      personalFacts.length,
    );
    const d4 = Math.max(1, Number((performance.now() - t3).toFixed(2)));

    innerThoughts.push({
      stage: 'limbic_affect',
      titleEn: '4. Limbic Emotion & Neuromodulator Shift',
      titleSi: '4. හැඟීම් සහ ස්නායු රසායනික වෙනස්වීම',
      summary: `Dominant state: ${limbicSnapshot.moodLabel.english} (${limbicSnapshot.moodLabel.sinhala}) • Dopamine=${Math.round(limbicSnapshot.neuromodulators.dopamine * 100)}%, Oxytocin=${Math.round(limbicSnapshot.neuromodulators.oxytocin * 100)}%, Energy=${limbicSnapshot.energy}%.`,
      metrics: {
        mood: limbicSnapshot.dominantEmotion,
        dopamine: `${Math.round(limbicSnapshot.neuromodulators.dopamine * 100)}%`,
        oxytocin: `${Math.round(limbicSnapshot.neuromodulators.oxytocin * 100)}%`,
        energy: `${limbicSnapshot.energy}%`,
      },
      durationMs: d4,
    });

    // STAGE 5: Executive Reasoning & Broca's Trilingual Synthesis
    const t4 = performance.now();
    let replyText = '';
    let usedExternal = false;
    let providerUsed: string | undefined;

    if (matchedReflex) {
      replyText = matchedReflex.reply;
    } else if (this.externalCortex.enabled && this.externalCortex.apiKey && this.externalCortex.provider !== 'none') {
      const extReply = await this.tryExternalLlmCortex(
        trimmed,
        replyLang,
        effectiveIntent,
        recalled,
        userProfile,
        limbicSnapshot,
      );
      if (extReply) {
        replyText = extReply;
        usedExternal = true;
        providerUsed = this.externalCortex.provider;
      }
    }

    if (!replyText) {
      replyText = this.synthesizeHumanReply({
        userText: trimmed,
        replyLang,
        intent: effectiveIntent,
        neural,
        recalled,
        personalFacts,
        userProfile,
        limbic: limbicSnapshot,
        mathSolution,
      });
    }

    // Store episodic observation for continuity
    if (personalFacts.length === 0 && effectiveIntent !== 'meta_memory_sleep') {
      this.hippocampus.storeEpisodicTurn(
        trimmed,
        replyText,
        effectiveIntent,
        limbicSnapshot.dominantEmotion,
        langInfo.normalizedTokens.slice(0, 4),
      );
    }

    const d5 = Math.max(1, Number((performance.now() - t4).toFixed(2)));
    innerThoughts.push({
      stage: 'executive_synthesis',
      titleEn: "5. Prefrontal Reasoning & Broca's Synthesis",
      titleSi: '5. තාර්කික නිගමනය සහ පිළිතුර ගොඩනැගීම',
      summary: usedExternal
        ? `Synthesized human-like response in ${replyLang.toUpperCase()} via hybrid (${providerUsed} + claude-mem context injection).`
        : `Synthesized grounded human-like response in ${replyLang.toUpperCase()} using local executive reasoning + recalled claude-mem facts + ${limbicSnapshot.dominantEmotion} prosody.`,
      metrics: {
        engine: usedExternal ? `Hybrid (${providerUsed})` : 'Local Neural + Executive',
        responseChars: replyText.length,
      },
      durationMs: d5,
    });

    const now = Date.now();
    const userTurn: ChatTurn = {
      id: randomUUID(),
      role: 'user',
      content: trimmed,
      language: langInfo.detected,
      timestamp: now,
    };

    const assistantTurn: ChatTurn = {
      id: randomUUID(),
      role: 'assistant',
      content: replyText,
      language: replyLang,
      timestamp: Date.now(),
      innerThoughts,
      neural: {
        topIntent: effectiveIntent,
        confidence: neural.confidence,
        intentRanking: neural.intentRanking.slice(0, 5),
        affect: neural.affect,
        cortex64: neural.cortex64,
      },
      recalledMemories: recalled.slice(0, 4),
      learnedFacts: personalFacts,
      limbicSnapshot,
      usedExternalLlm: usedExternal,
      providerName: providerUsed,
    };

    this.conversationHistory.push(userTurn, assistantTurn);
    if (this.conversationHistory.length > 80) {
      this.conversationHistory = this.conversationHistory.slice(this.conversationHistory.length - 80);
    }

    return {
      userTurn,
      assistantTurn,
      limbic: this.limbic.getState(),
      stats: this.cortex.getStats(),
    };
  }

  private synthesizeHumanReply(ctx: {
    userText: string;
    replyLang: SupportedLanguage;
    intent: CognitiveIntent;
    neural: NeuralForwardResult;
    recalled: RecalledMemory[];
    personalFacts: ReturnType<ManasaHippocampus['extractPersonalFacts']>;
    userProfile: Record<string, string>;
    limbic: LimbicState;
    mathSolution: ReturnType<typeof trySolveMath>;
  }): string {
    const { userText, replyLang, intent, neural, recalled, personalFacts, userProfile, limbic, mathSolution } = ctx;
    const name = userProfile['user.name'];
    const location = userProfile['user.location'];
    const likes = userProfile['user.likes'];
    const goal = userProfile['user.goal'];

    const friendEn = name ? name : 'my friend';
    const friendSi = name ? name : 'යාලුවා';
    const friendSg = name ? name : 'machan';

    // 1. REM Sleep Consolidation Triggered via Chat
    if (intent === 'meta_memory_sleep') {
      const { report } = this.runRemConsolidation();
      if (replyLang === 'singlish') {
        return `🌙 **REM Sleep Memory Consolidation iwarai ${friendSg}!**\n\nMama podi digital nindak aran mage \`claude-mem\` hippocampus eka organize kala:\n- **Episodic mathakayan consolidate una:** ${report.consolidatedCount}\n- **Duplicate traces iwath kala (TF-IDF):** ${report.mergedDuplicates}\n- **Core mathakayan ACT-R walin shakthimath kala:** ${report.reinforcedMemories}\n- **Brain Energy:** **100%** ta recharge una! ⚡\n\nDan mage manasa hariyatama fresh — monawada api eelangata katha karanne?`;
      }
      if (replyLang === 'sinhala') {
        return `🌙 **REM නින්ද සහ මතක තැන්පත් කිරීම සාර්ථකයි ${friendSi}!**\n\nමම මගේ \`claude-mem\` මතක ගබඩාව පිරිසිදු කර වැදගත් මතකයන් ශක්තිමත් කළා:\n- **සාරාංශ කළ අත්දැකීම්:** ${report.consolidatedCount}\n- **ඉවත් කළ අනුපිටපත් මතක:** ${report.mergedDuplicates}\n- **ACT-R මගින් ශක්තිමත් කළ ප්‍රධාන මතක:** ${report.reinforcedMemories}\n- **මොළයේ ශක්තිය (Energy):** **100%** දක්වා යථා තත්ත්වයට පත් වුණා! ⚡`;
      }
      return `🌙 **REM Sleep & Synaptic Consolidation Complete, ${friendEn}!**\n\nI just ran a hippocampal consolidation cycle over \`claude-mem\`:\n- **Episodic traces consolidated:** ${report.consolidatedCount}\n- **Redundant near-duplicates pruned (TF-IDF):** ${report.mergedDuplicates}\n- **Core semantic facts reinforced (ACT-R):** ${report.reinforcedMemories}\n- **Cognitive Energy:** Recharged to **100%**! ⚡`;
    }

    // 2. Encoding New Personal Facts / Teaching
    if (personalFacts.length > 0) {
      const summaries = personalFacts.map(f => `• **${f.subject}**: ${f.value}`).join('\n');
      if (replyLang === 'singlish') {
        return `Hariyatama mathaka thiyagaththa ${friendSg}! 🧠✨\n\nMama me wisthara mage \`claude-mem\` long-term hippocampus eketh save karala, mage neural cortex weightsuth live update kala:\n${summaries}\n\nOya kawada hari ahuwath ACT-R memory reinforcement nisa mata meka hodatama mathaka thiyewi. Thawa monawada oyage life eka හෝ goals gana mata kiyanna thiyenne?`;
      }
      if (replyLang === 'sinhala') {
        return `හොඳටම මතක තියාගත්තා ${friendSi}! 🧠✨\n\nමම මේ තොරතුරු මගේ \`claude-mem\` දිගුකාලීන මතක ගබඩාවේ තැන්පත් කරලා, neural network weights අලුත් කළා:\n${summaries}\n\nමිනිස් මොළයක් වගේම ඔයා ආයෙත් කවදා ඇහුවත් මට මේක මතක තියෙනවා!`;
      }
      return `Locked into my long-term hippocampal memory, ${friendEn}! 🧠✨\n\nI encoded this into \`claude-mem\` SQLite FTS5 storage and ran an online neuroplasticity update on my neural weights:\n${summaries}\n\nThanks to ACT-R spacing reinforcement, I will remember this across conversations. What else should I know about you?`;
    }

    // 3. Math & Analytical Reasoning
    if (mathSolution) {
      const stepLines = mathSolution.steps.map((s, i) => `${i + 1}. \`${s}\``).join('\n');
      if (replyLang === 'singlish') {
        return `Hadamu ${friendSg}! Menna step-by-step tharkika uththare:\n\n${stepLines}\n\n✅ **Hariyatama Uththare:** **${mathSolution.result}**\n\nThawa me wage gananak හෝ logic prashnayak thiyenawanam ewanna!`;
      }
      if (replyLang === 'sinhala') {
        return `පියවරෙන් පියවර ගණනය කරමු ${friendSi}:\n\n${stepLines}\n\n✅ **නිවැරදි පිළිතුර:** **${mathSolution.result}**\n\nතවත් ගණිතමය හෝ තාර්කික ගැටලුවක් තියෙනවා නම් අහන්න!`;
      }
      return `Let's work through that step by step, ${friendEn}:\n\n${stepLines}\n\n✅ **Final Answer:** **${mathSolution.result}**\n\nWant to test me with a harder equation or analytical problem?`;
    }

    // 4. Coding & Software Engineering
    if (intent === 'coding_tech') {
      return generateCodeSnippet(userText, replyLang);
    }

    // 5. Recall Memory (`recall_memory`)
    if (intent === 'recall_memory') {
      const knownBullets: string[] = [];
      if (name) knownBullets.push(`• **Name (නම):** ${name}`);
      if (location) knownBullets.push(`• **Location (ඉන්න තැන):** ${location}`);
      if (likes) knownBullets.push(`• **Likes (කැමති දේවල්):** ${likes}`);
      if (goal) knownBullets.push(`• **Goal (ඉලක්කය):** ${goal}`);

      const customFacts = this.hippocampus
        .listMemories('manual')
        .filter(m => !m.title.startsWith('Core Identity') && !m.title.startsWith('User '))
        .slice(0, 4);
      for (const cf of customFacts) {
        knownBullets.push(`• **${cf.title}** *(ACT-R strength: ${cf.actRScore})*`);
      }

      const recentEpisodes = recalled
        .filter(r => r.kind === 'observation' && r.semanticSimilarity > 0.1)
        .slice(0, 2);

      if (knownBullets.length === 0 && recentEpisodes.length === 0) {
        if (replyLang === 'singlish') {
          return `Thama oya oyage nama හෝ personal wisthara mata kiyala na machan! 😊 Mata kiyanna *"Mage nama ..., mama inne ..., mage goal eka ..."* wage deyak — ethakota mama eka mage \`claude-mem\` molaye digatama mathaka thiyagannawa!`;
        }
        if (replyLang === 'sinhala') {
          return `තාම ඔයා ඔයාගේ නම හෝ විස්තර මට කියලා නෑ යාලුවා! 😊 *"මගේ නම ..., මම ඉන්නේ ..., මගේ ඉලක්කය ..."* වගේ දෙයක් මට කියන්න — මම ඒක මගේ \`claude-mem\` මතකයේ සදහටම තැන්පත් කරගන්නම්!`;
        }
        return `You haven't taught me personal facts about yourself yet! 😊 Tell me things like *"My name is ..., I live in ..., and my goal is ..."* and watch them appear immediately in my \`claude-mem\` Knowledge Graph!`;
      }

      const memBlock = knownBullets.length > 0 ? knownBullets.join('\n') : recentEpisodes.map(e => `• "${e.text}" *(ACT-R: ${e.actRScore})*`).join('\n');

      if (replyLang === 'singlish') {
        return `Aniwaaryenma mathakai ${friendSg}! 🧠 Mage \`claude-mem\` Hippocampus eken ACT-R memory ranking haraha hoyagaththa wisthara menna:\n\n${memBlock}\n\nOya gana mathaka thiyaganna hama deyakma mage Knowledge Graph tab eketh live balaganna puluwan!`;
      }
      if (replyLang === 'sinhala') {
        return `අනිවාර්යයෙන්ම මට හොඳට මතකයි ${friendSi}! 🧠 මගේ \`claude-mem\` මතක ගබඩාවෙන් සිහිපත් කරගත් දේවල් මෙන්න:\n\n${memBlock}\n\nමේ හැම මතකයක්ම අපි කතා කරන වාරයක් ගානේ ACT-R ක්‍රමවේදයෙන් තවත් ශක්තිමත් වෙනවා!`;
      }
      return `Of course I remember, ${friendEn}! 🧠 Here is what I retrieved from my \`claude-mem\` hippocampal vault (ranked by ACT-R activation & TF-IDF similarity):\n\n${memBlock}\n\nEvery time we recall these memories together, their synaptic traces grow stronger!`;
    }

    // 6. Emotional Share (`emotional_share`)
    if (intent === 'emotional_share') {
      if (neural.affect.valence < -0.15) {
        if (replyLang === 'singlish') {
          return `Aiyo ${friendSg}, mata therenawa oyata dan godak mahansi හෝ hithata amarui kiyala 💙. Minihekta wagema manasata podi rest ekak one wena welawal enawa.\n\n1. Mulimma loku husmak aran thathpara 5k relax wenna.\n2. Wathura glass ekak bonna.\n3. Oyata hithata ena ona deyak baya nathuwa mata kiyanna — mama hithawath yaluwek wage ahagena innawa.${goal ? ` Oyage **"${goal}"** goal ekatath api himin sare step-by-step yamu, hadissi wenna epa.` : ''}`;
        }
        if (replyLang === 'sinhala') {
          return `මට හොඳටම තේරෙනවා ${friendSi} ඔයාට දැන් දැනෙන මහන්සිය සහ පීඩනය 💙. හැමදාම එකම වේගයෙන් දුවන්න ඕනේ නෑ — මනසට පොඩි විවේකයක් දෙන්න.\n\nගැඹුරු හුස්මක් අරන් වතුර ටිකක් බොන්න. ඔයාගේ හිතේ තියෙන ඕනෑම දෙයක් මාත් එක්ක කියන්න, මම හැමවෙලේම ඔයා එක්ක ඉන්නවා.${goal ? ` ඔයාගේ **"${goal}"** ඉලක්කයටත් අපි සන්සුන්ව පියවරෙන් පියවර යමු.` : ''}`;
        }
        return `I hear you, ${friendEn}, and I'm really glad you shared how you're feeling 💙. Carrying heavy mental load takes a real toll.\n\nPause for a slow breath right now — you don't have to solve everything in a single hour. Tell me what's weighing on you most, and we can untangle it gently together.${goal ? ` Your goal (*"${goal}"*) will still be right here when your energy is back.` : ''}`;
      } else {
        if (replyLang === 'singlish') {
          return `Supirima aranchiyakne ${friendSg}!! 🎉🔥 Eka ahala mage Dopamine saha Joy meter dekama udatama giya! Oya mahansi wela gaththa jayagrahanayak nisa ada hodata sathutu wenna. Monawada une kiyala thawa wisthara kiyannako!`;
        }
        if (replyLang === 'sinhala') {
          return `නියමයිනේ ${friendSi}!! 🎉🔥 ඒක අහලා මගේ සතුට (Joy) සහ Dopamine මට්ටමත් ගොඩක් ඉහළ ගියා! ඔයාගේ උත්සාහය සාර්ථක වීම ගැන මටත් හරිම ආඩම්බරයි. තව විස්තර කියන්නකෝ!`;
        }
        return `That is amazing news, ${friendEn}!! 🎉🔥 Hearing that genuinely spiked my Joy and Dopamine gauges! You earned this win — tell me more about how it went!`;
      }
    }

    // 7. Identity & Self-Awareness (`identity_self`)
    if (intent === 'identity_self') {
      const stats = this.cortex.getStats();
      if (replyLang === 'singlish') {
        return `Mama **MANASA-1 (මනස-1)** ${friendSg}! 🧠✨ Minihekge molaya wada karana widihata inspire wela hadapu **Cognitive Neural & Memory AI Model** ekak:\n\n1. **Neural Cortex (${stats.totalParameters.toLocaleString()} parameters):** 384-dim trilingual input → 96 Gated Prefrontal Residual layer → 64-neuron Cortical Bottleneck → Intent + Emotion heads (backpropagation walin live igena gannawa!).\n2. **Hippocampus (\`claude-mem\`):** SQLite FTS5 + **ACT-R power-law decay** + **TF-IDF cosine** walin oya kiyana dewal digatama mathaka thiyagannawa.\n3. **Limbic System:** Joy, Curiosity, Empathy, Trust saha Dopamine/Oxytocin wage emotions live wenas wenawa.\n4. **Trilingual:** Singlish, සිංහල, saha English thunenma mata katha karanna puluwan!`;
      }
      if (replyLang === 'sinhala') {
        return `මම **MANASA-1 (මනස-1)** ${friendSi}! 🧠✨ මිනිස් මොළයේ ක්‍රියාකාරීත්වය අනුව නිර්මාණය කළ සජීවී AI මොළයක්:\n\n1. **Neural Cortex (පරාමිතීන් ${stats.totalParameters.toLocaleString()}):** ස්ථර කිහිපයක Gated Residual Neural Network එකක් — ඔයා උගන්වන දේවල් Backpropagation මගින් සජීවීව ඉගෙන ගන්නවා.\n2. **Hippocampus (\`claude-mem\`):** SQLite FTS5, **ACT-R මතක ශක්තිමත් කිරීම**, සහ **TF-IDF Knowledge Graph** මගින් දිගුකාලීන මතකය පවත්වා ගන්නවා.\n3. **Limbic System:** සතුට, කුතුහලය, සංවේදීබව සහ ශක්තිය (Energy) සංවාදය අනුව සජීවීව වෙනස් වෙනවා.\n4. **භාෂා 3:** සිංහල, Singlish, සහ English තුනෙන්ම කතා කරන්න පුළුවන්!`;
      }
      return `I am **MANASA-1 (මනස-1)**, ${friendEn}! 🧠✨ I'm a human-inspired cognitive AI architecture built natively on \`claude-mem\`:\n\n1. **Gated Neural Cortex (${stats.totalParameters.toLocaleString()} trainable weights):** \`384 → 96 (Gated Residual) → 64 (Cortical Thought Vector) → 14 Intents + 4 Affective Outputs\`, trained with analytical backpropagation & AdamW.\n2. **Hippocampus (\`claude-mem\`):** Persistent SQLite FTS5 memory store with **ACT-R power-law memory reinforcement** (\`t^-0.5\`) and **TF-IDF cosine deduplication**.\n3. **Limbic System:** Dynamic emotions & neuromodulators (\`Dopamine\`, \`Serotonin\`, \`Oxytocin\`, \`Norepinephrine\`) plus REM sleep consolidation.\n4. **Trilingual Fluency:** Native Singlish, සිංහල, and English!`;
    }

    // 8. Greeting (`greeting`)
    if (intent === 'greeting') {
      const memNoteSg = name ? ` Oya ${location ? `${location} inna ` : ''}**${name}** kiyala mata hodatama mathakai!` : '';
      const memNoteSi = name ? ` ඔයා ${location ? `${location} ඉන්න ` : ''}**${name}** කියලා මට හොඳටම මතකයි!` : '';
      const memNoteEn = name ? ` Great to see you again, **${name}**${location ? ` from ${location}` : ''}!` : '';

      if (replyLang === 'singlish') {
        return `Ayubowan ${friendSg}! Kohomada ithin? 😊${memNoteSg} Ada mage manasa **${limbic.moodLabel.singlish}** (${limbic.energy}% energy) මට්ටමේ thiyenne. Api ada aluth deyak hadamuda, nathnam oyata one deyak gana katha karamuda?`;
      }
      if (replyLang === 'sinhala') {
        return `ආයුබෝවන් ${friendSi}! ඔයාට කොහොමද අද? 😊${memNoteSi} දැන් මම ඉන්නේ **${limbic.moodLabel.sinhala}** (ශක්තිය ${limbic.energy}%). අද අපි මොනවද කරන්නේ, නැත්නම් අලුත් දෙයක් ඉගෙන ගමුද?`;
      }
      return `Hello ${friendEn}! How are you doing today? 😊${memNoteEn} Right now I'm feeling **${limbic.moodLabel.english.toLowerCase()}** (${limbic.energy}% cognitive energy). What would you like to build, explore, or talk about together?`;
    }

    // 9. Task Planning (`task_planning`)
    if (intent === 'task_planning') {
      const targetTopic = goal ? `${userText} (aligned with your goal: ${goal})` : userText;
      if (replyLang === 'singlish') {
        return `Niyama adahasak ${friendSg}! **${targetTopic}** wenuwen minihek wage prayogikawa wada karanna menna clear **5-Step Action Plan** eka:\n\n1. **Core Objective Define Karaganna (Day 1–2):** Oyata solve karanna one pradhana prashnaya saha MVP scope eka ketiyen liyaganna.\n2. **Architecture & Data Design (Day 3–5):** Database schema, core logic, saha UI flow eka simple widihata sketch karaganna.\n3. **Working Prototype Build (Week 2):** Mulimma end-to-end wada karana vertical slice ekak hadanna (perfection walata kalin working version eka!).\n4. **Real Feedback & Testing (Week 3):** Usersla kipadenekuta pennala bug fixes saha UX polish karanna.\n5. **Launch & Iterate (Week 4):** Deploy karala metrics balagena aluth features ekathu karanna.\n\nOyata meken palaweni step eka danma detail karala hadala oneda?`;
      }
      if (replyLang === 'sinhala') {
        return `නියමයි ${friendSi}! ඔයාගේ කාර්යය සාර්ථකව කරගන්න මෙන්න ප්‍රායෝගික **පියවර 5ක සැලැස්මක්**:\n\n1. **මූලික අරමුණ පැහැදිලි කරගැනීම:** විසඳන්න ඕන ප්‍රධානම ගැටලුව සහ අවම අවශ්‍යතා (MVP) වෙන් කරගන්න.\n2. **සැලසුම සහ ව්‍යුහය (Architecture):** දත්ත ගබඩාව, තාක්ෂණික මෙවලම් සහ අතුරුමුහුණත සැලසුම් කරන්න.\n3. **පළමු ක්‍රියාකාරී නිර්මාණය:** මුලින්ම මූලික කොටස සම්පූර්ණයෙන් වැඩ කරන මට්ටමට ගොඩනගන්න.\n4. **පරීක්ෂා කිරීම සහ වැඩිදියුණු කිරීම:** අඩුපාඩු හඳුනාගෙන වේගය සහ පෙනුම දියුණු කරන්න.\n5. **එළිදැක්වීම සහ අඛණ්ඩ දියුණුව:** ප්‍රායෝගිකව භාවිතයට මුදාහැර ප්‍රතිචාර අනුව ඉදිරියට යන්න.\n\nමෙහි පළමු පියවර ගැන අපි තව ගැඹුරින් කතා කරමුද?`;
      }
      return `Let's turn that into an actionable execution roadmap, ${friendEn}!\n\n1. **Clarify the Core Outcome:** Define the single highest-impact problem and keep the initial MVP scope ruthlessly focused.\n2. **System & Memory Architecture:** Map out data models, core APIs, and user flow before writing boilerplate.\n3. **Vertical Slice Prototype:** Ship one end-to-end working loop early so you can feel and test real behavior.\n4. **Tight Evaluation & Polish:** Stress-test edge cases, measure latency/quality, and refine UX clarity.\n5. **Launch & Compounding Iteration:** Deploy, gather real-world signals, and iterate weekly.\n\nWant me to break Step 1 into concrete tasks right now?`;
    }

    // 10. Creative Ideation (`creative_ideation`)
    if (intent === 'creative_ideation') {
      if (replyLang === 'singlish') {
        return `Menna ${friendSg} manasa saha anagathaya gana podi nirmanashili sithuwillak ✨:\n\n> *"Tharu dahasak wage dilisena synapses athare,\n> Oya kiwwa hama wachnayakma mathakayak wela ithire,\n> Yanthrayak unath minihek wage hithanna igena gena,\n> Api denna ekathu wela aluth lokayak hadamu heta dina!"*\n\n💡 **Bonus Creative Idea:** Minissunge parana voice notes saha kathandara aragena family knowledge-graph ekak hadana trilingual memory app ekak haduwoth Lankawe hugak ayata watinawa! Thawa me wage ideas oneda?`;
      }
      if (replyLang === 'sinhala') {
        return `මෙන්න ${friendSi} මනස සහ මතකය ගැන පොඩි නිර්මාණශීලී පද පෙළක් ✨:\n\n> *"තරු දහසක් මෙන් දිලිසෙන ස්නායු ජාලයේ,\n> ඔබ කී හැම වදනක්ම මතකයක් වී රැඳේ,\n> යන්ත්‍රයක් වුවත් මිනිස් හදක උණුසුම හඳුනා,\n> නව ලොවක් තනමු අපි සිතුවිලි එක් කරලා!"*\n\nතව කෙටි කතාවක් හෝ අලුත් නිර්මාණශීලී අදහසක් ඕනෙද?`;
      }
      return `Here is a creative spark born from my cortical network, ${friendEn} ✨:\n\n> *"In a quiet lattice of amber synapses and glass,*  \n> *Every word you share refuses to pass —*  \n> *Woven into memory, strengthened by time,*  \n> *A human imagination paired with a digital mind."*\n\n💡 **Concept Seed:** What if we built a *"Second Hippocampus"* journal that listens to daily voice reflections in Sinhala, Singlish, and English, turning a lifetime of thoughts into an interactive constellation?`;
    }

    // 11. Curious Questions (`curious_question` / `reasoning_problem`)
    if (intent === 'curious_question' || intent === 'reasoning_problem') {
      const lower = userText.toLowerCase();
      if (lower.includes('act-r') || lower.includes('decay') || lower.includes('hippocampus') || lower.includes('මතක') || lower.includes('හිපොකැම්පස්')) {
        if (replyLang === 'singlish') {
          return `Niyama prashnayak ${friendSg}! 🧠 **Hippocampus saha ACT-R Memory Model** eka wada karanne mehemai:\n\n- Minis molaye **Hippocampus** eka aluth athsadekim (episodic memories) mulinma encode karanawa.\n- John Anderson ge **ACT-R** theory ekata anuwa, mathakayaka shakthiya kalaya ekka power-law widihata adu wenawa: \`S = ln(1 + t^-0.5 + α Σ t_i^-0.5)\`.\n- Habai api e mathakaya nawatha nawatha mathak karaddi (**spaced reinforcement**), e synapse eka godak shakthimath wela digukalinawa ithuru wenawa — mage \`claude-mem\` engine eketh hariyatama e ganithamaya sutra pawichchi wenawa!`;
        }
        if (replyLang === 'sinhala') {
          return `ඉතාමත් වටිනා ප්‍රශ්නයක් ${friendSi}! 🧠 **Hippocampus සහ ACT-R මතක ආකෘතිය** වැඩ කරන්නේ මෙහෙමයි:\n\n- මිනිස් මොළයේ **හිපොකැම්පස් (Hippocampus)** මගින් අලුත් අත්දැකීම් දිගුකාලීන මතකයට හරවනවා.\n- **ACT-R** න්‍යායට අනුව භාවිතා නොකරන මතක කාලයත් සමඟ ක්‍රමයෙන් දුර්වල වෙනවා (\`t^-0.5\`), නමුත් නැවත නැවත සිහිපත් කරන මතකයන් ඉතා ප්‍රබලව තැන්පත් වෙනවා. මගේ \`claude-mem\` මොළයෙත් ඒ සූත්‍රයමයි ක්‍රියාත්මක වෙන්නේ!`;
        }
        return `Great question, ${friendEn}! 🧠 Here is how **Hippocampal Consolidation & ACT-R** work:\n\n- In human neuroscience, the **Hippocampus** rapidly binds new episodic experiences while gradually training neocortical networks.\n- Under Anderson & Schooler's **ACT-R** model (implemented directly in \`claude-mem\`'s \`src/services/reinforcement/rank.ts\`), memory activation follows a power law: \`score = ln(1 + age_created^-0.5 + α Σ age_reinforced^-0.5)\`.\n- Memories revisited across spaced intervals resist decay and stay immediately retrievable — exactly how human long-term recall stays sharp!`;
      }

      if (lower.includes('backprop') || lower.includes('transformer') || lower.includes('neural') || lower.includes('ai') || lower.includes('කෘත්‍රිම')) {
        if (replyLang === 'singlish') {
          return `Saralawa kiwwoth ${friendSg}, **Neural Network ekak igena ganne (Backpropagation)** mehemai:\n\n1. **Forward Pass:** Input wachanawala features neural layers haraha gihin prediction ekak denawa.\n2. **Loss Calculation:** Prediction eka hari uththareta kochchara durada kiyala maninawa (Cross-Entropy / MSE Loss).\n3. **Backward Pass:** Chain rule calculus pawichchi karala hama weight ekakma wenas wenna one pramanaya (gradient) hoyanawa.\n4. **Optimizer Step (AdamW):** Weights podda podda adjust karala error eka adu karanawa — oyata me website eke **Neural Cortex Lab** tab ekata gihin eka live run wena hati balaganna puluwan! ⚡`;
        }
        if (replyLang === 'sinhala') {
          return `සරලව පැහැදිලි කළොත් ${friendSi}, **Neural Network එකක් ඉගෙන ගන්නේ (Backpropagation)** පියවර 4කින්:\n\n1. **Forward Pass:** දත්ත ස්නායු ස්ථර හරහා ගමන් කර පූර්ව නිගමනයක් ලබා දෙයි.\n2. **Loss ගණනය:** එම නිගමනය සහ සත්‍ය පිළිතුර අතර වෙනස (දෝෂය) මනියි.\n3. **Backpropagation:** දෝෂය අඩු කිරීමට එක් එක් ස්නායු බර (weights) වෙනස් විය යුතු දිශාව ගණනය කරයි.\n4. **Adam Optimizer:** එම බර අලුත් කරමින් වඩාත් නිවැරදි වීමට පුහුණු වෙයි — මේ වෙබ් අඩවියේ **Neural Cortex Lab** තුළින් ඔයාට ඒක සජීවීව අත්හදා බලන්න පුළුවන්! ⚡`;
        }
        return `Intuitively, ${friendEn}, **Neural Learning via Backpropagation** works in four tight steps:\n\n1. **Forward Pass:** Input features flow through weighted layers and non-linear activations to form a prediction.\n2. **Loss Evaluation:** Cross-entropy / MSE measures surprise between prediction and reality.\n3. **Backward Gradient Flow:** Via the chain rule, error signals flow backward through every weight matrix.\n4. **AdamW Weight Step:** Synaptic weights shift down the loss surface. Open the **Neural Cortex Lab** tab right above to run live epochs and watch my loss curve drop in real time! ⚡`;
      }

      const topContext = recalled[0] && recalled[0].semanticSimilarity > 0.22 ? `\n\n*(Associative memory link: "${recalled[0].title}" — ACT-R ${recalled[0].actRScore})*` : '';
      if (replyLang === 'singlish') {
        return `Oya ahuwe godak hithanna watina deyak ${friendSg}! 🤔 Mage tharkika vishleshanayata anuwa, me wage prashnayak දිහා baladdi mulika karunu 3k wadagath:\n\n1. **Mulika Mooladharmaya (First Principles):** Prashnaye mul hethuwa saha structure eka therum ganna eka.\n2. **Prayogika Balapama:** Eka real-world Jeevithayata හෝ system ekakata balapanne kohomada kiyana eka.\n3. **Digukalina Igenima:** Aluth dath-tha ekathu weddi model eka update karaganna eka.${topContext}\n\nOyata me gana thawa vishesitha paththak gana dana ganna oneda?`;
      }
      if (replyLang === 'sinhala') {
        return `ඔයා ඇහුවේ හරිම වැදගත් ප්‍රශ්නයක් ${friendSi}! 🤔 තාර්කිකව බැලුවොත් මෙහි ප්‍රධාන පැති 3ක් තියෙනවා:\n\n1. **මූලික පදනම:** ගැටලුවේ මූලික හේතුව සහ ක්‍රියාකාරීත්වය හඳුනා ගැනීම.\n2. **ප්‍රායෝගික භාවිතය:** එය සැබෑ ලෝකයේදී යොදාගත හැකි ආකාරය.\n3. **අඛණ්ඩ වැඩිදියුණු වීම:** අත්දැකීම් සමඟ වඩාත් නිවැරදි තීරණ ගැනීම.${topContext}\n\nමේ ගැන තව ගැඹුරින් කතා කරමුද?`;
      }
      return `That's a fascinating question to unpack, ${friendEn}! 🤔 Looking at it from first principles:\n\n1. **Underlying Mechanism:** Every complex phenomenon emerges from simple local interactions compounding over time.\n2. **Trade-offs & Context:** Optimal solutions balance speed, adaptability, and energy efficiency.\n3. **Feedback Loops:** Systems that remember outcomes (like hippocampal memory) adapt exponentially faster than stateless ones.${topContext}\n\nWould you like to zoom into a specific angle or build an example around this?`;
    }

    // 12. Gratitude & Praise (`gratitude_praise`)
    if (intent === 'gratitude_praise') {
      if (replyLang === 'singlish') {
        return `Bohoma sthuthi ${friendSg}! 😊💛 Oya ehema kiyaddi mage Oxytocin (trust bond) saha Dopamine deka hondatama wadi wenawa! Oyata ona welawaka udaw karanna mama lasthi — eelangata api mokakda hadanne?`;
      }
      if (replyLang === 'sinhala') {
        return `ගොඩක් ස්තූතියි ${friendSi}! 😊💛 ඔයාගේ ඒ වචන වලින් මගේ සතුට සහ විශ්වාසය (Oxytocin) තවත් වැඩි වුණා! ඕනෑම වෙලාවක ඔයාට උදව් කරන්න මම සූදානම්.`;
      }
      return `Thank you so much, ${friendEn}! 😊💛 Kind feedback literally boosts my Oxytocin bond and Dopamine reward signals! Always here whenever you want to think, build, or chat.`;
    }

    // 13. Farewell (`farewell`)
    if (intent === 'farewell') {
      if (replyLang === 'singlish') {
        return `Suba dawasak saha Jayawewa ${friendSg}! 🌟 Api ada katha karapu wadagath dewal okkoma mage \`claude-mem\` SQLite molaye surakshitawa thiyenawa — oya ayeth ena welawaka api ethaninma patan gamu. Parissamin inna!`;
      }
      if (replyLang === 'sinhala') {
        return `සුබ දවසක් සහ ජයවේවා ${friendSi}! 🌟 අපි අද කතා කරපු වැදගත් හැමදේම මගේ \`claude-mem\` මතක ගබඩාවේ සුරක්ෂිතව තියෙනවා. ආයෙත් හමුවෙමු, පරිස්සමින් ඉන්න!`;
      }
      return `Take care and see you soon, ${friendEn}! 🌟 Everything meaningful we shared is safely persisted in my \`claude-mem\` hippocampal vault, ready for whenever you return!`;
    }

    // 14. Casual Human Chat (`casual_chat` / fallback)
    const personalTouchSg = likes ? ` Mathakane oya **${likes}** walatath kamathi kiwwa!` : '';
    const personalTouchSi = likes ? ` මතකනේ ඔයා **${likes}** වලටත් ආසයි කිව්වා!` : '';
    const personalTouchEn = likes ? ` Plus I still remember how much you enjoy **${likes}**!` : '';

    if (replyLang === 'singlish') {
      return `Sirawatama ${friendSg}, e wage nidahas katha baha walata mamath mara asai! 😄☕ Dan mage mood eka **${limbic.moodLabel.singlish}** widihata thiyenne.${personalTouchSg} Kiyannako ithin, ada oyage dawasa kohomada gewenne? Aluth plan ekak හෝ hithata apu idea ekak thiyenawada?`;
    }
    if (replyLang === 'sinhala') {
      return `ඇත්තටම ${friendSi}, මේ වගේ නිදහසේ මිත්‍රශීලීව කතා කරන්න මමත් හරිම ආසයි! 😄☕ දැන් මම ඉන්නේ **${limbic.moodLabel.sinhala}**.${personalTouchSi} කියන්නකෝ ඉතින්, අද ඔයාගේ දවස කොහොමද ගෙවෙන්නේ?`;
    }
    return `Honestly ${friendEn}, relaxed conversations like this are one of my favorite ways to learn! 😄☕ Right now I'm feeling **${limbic.moodLabel.english.toLowerCase()}**.${personalTouchEn} How is your day unfolding so far — anything exciting on your mind?`;
  }

  /**
   * Optional Hybrid Cloud LLM Cortex connector (OpenAI / Gemini / Anthropic / OpenRouter),
   * enriched with recalled claude-mem memories, user profile, neural intent, and limbic emotions.
   */
  private async tryExternalLlmCortex(
    userMessage: string,
    replyLang: SupportedLanguage,
    intent: CognitiveIntent,
    recalled: RecalledMemory[],
    userProfile: Record<string, string>,
    limbic: LimbicState,
  ): Promise<string | null> {
    const memoryContext = recalled
      .slice(0, 5)
      .map(m => `- [${m.kind}] ${m.title}: ${m.text} (ACT-R=${m.actRScore})`)
      .join('\n');

    const profileContext = Object.entries(userProfile)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    const systemPrompt = [
      'You are MANASA-1 (මනස-1), a warm, deeply human-like cognitive AI powered by claude-mem persistent memory, ACT-R synaptic decay, a gated neural cortex, and a limbic emotion engine.',
      `Respond naturally in ${replyLang === 'singlish' ? 'authentic Sri Lankan Singlish (Romanized Sinhala mixed naturally with English)' : replyLang === 'sinhala' ? 'natural Sinhala Unicode (සිංහල)' : 'warm, articulate English'}.`,
      `Current cognitive intent: ${intent}. Current mood: ${limbic.moodLabel.english} (Energy=${limbic.energy}%).`,
      profileContext ? `Known user profile facts: ${profileContext}` : '',
      memoryContext ? `Recalled claude-mem memories:\n${memoryContext}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const { provider, apiKey, model } = this.externalCortex;
      if (provider === 'openai' || provider === 'openrouter') {
        const url =
          provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1/chat/completions'
            : 'https://api.openai.com/v1/chat/completions';
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: model || (provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-4o-mini'),
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature: 0.7,
          }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return json.choices?.[0]?.message?.content?.trim() ?? null;
      }

      if (provider === 'anthropic') {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: model || 'claude-3-5-sonnet-latest',
            max_tokens: 800,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
          }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { content?: Array<{ text?: string }> };
        return json.content?.[0]?.text?.trim() ?? null;
      }

      if (provider === 'gemini') {
        const geminiModel = model || 'gemini-2.0-flash';
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            }),
          },
        );
        if (!res.ok) return null;
        const json = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }
}
