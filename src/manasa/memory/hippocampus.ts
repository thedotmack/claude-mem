// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import type { MemoryItem } from '../../core/schemas/memory-item.js';
import { buildIdfFn } from '../../services/dedup/idf.js';
import { tfidfCosine } from '../../services/dedup/tfidfCosine.js';
import { blendedScore } from '../../services/reinforcement/rank.js';
import {
  appendReinforcement,
  isoDay,
  parseReinforcementDates,
} from '../../services/reinforcement/strength.js';
import { applySqliteConnectionPragmas } from '../../services/sqlite/connection.js';
import {
  AgentEventsRepository,
  MemoryItemsRepository,
  ProjectsRepository,
  ServerSessionsRepository,
} from '../../storage/sqlite/index.js';
import { normalizeTokens } from '../model/tokenizer.js';
import type {
  ConsolidationReport,
  ExtractedFact,
  KnowledgeGraphData,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  RecalledMemory,
} from '../types.js';

const MANASA_PROJECT_SLUG = 'manasa-human-brain';
const ACT_R_ALPHA = 1.35;

/**
 * MANASA-1 Hippocampus & Neocortical Memory Vault
 * Powered directly by claude-mem's SQLite FTS5 storage (`MemoryItemsRepository`,
 * `ProjectsRepository`, `ServerSessionsRepository`, `AgentEventsRepository`),
 * ACT-R power-law reinforcement (`src/services/reinforcement/*`), and
 * IDF-weighted TF-IDF cosine semantic similarity (`src/services/dedup/*`).
 */
export class ManasaHippocampus {
  private db: Database;
  private projectsRepo: ProjectsRepository;
  private sessionsRepo: ServerSessionsRepository;
  private memoryRepo: MemoryItemsRepository;
  private eventsRepo: AgentEventsRepository;
  private projectId: string;
  private activeSessionId: string;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      applySqliteConnectionPragmas(this.db, { enableWal: true });
    }

    this.projectsRepo = new ProjectsRepository(this.db);
    this.sessionsRepo = new ServerSessionsRepository(this.db);
    this.memoryRepo = new MemoryItemsRepository(this.db);
    this.eventsRepo = new AgentEventsRepository(this.db);

    const existingProject = this.projectsRepo
      .list()
      .find(p => p.slug === MANASA_PROJECT_SLUG);

    if (existingProject) {
      this.projectId = existingProject.id;
    } else {
      const created = this.projectsRepo.create({
        name: 'MANASA-1 Human-Like Cognitive Brain',
        slug: MANASA_PROJECT_SLUG,
        rootPath: '/manasa/cognitive-vault',
        metadata: {
          architecture: 'claude-mem + ManasaNeuralCortex + ACT-R + LimbicEngine',
          languages: ['singlish', 'sinhala', 'english'],
        },
      });
      this.projectId = created.id;
    }

    const sessions = this.sessionsRepo.listByProject(this.projectId);
    const active = sessions.find(s => s.status === 'active');
    if (active) {
      this.activeSessionId = active.id;
    } else {
      const newSession = this.sessionsRepo.create({
        projectId: this.projectId,
        contentSessionId: `manasa-session-${Date.now()}`,
        memorySessionId: `manasa-mem-${Date.now()}`,
        platformSource: 'manasa-web',
        title: 'MANASA-1 Living Cognitive Stream',
        metadata: { startedIso: new Date().toISOString() },
      });
      this.activeSessionId = newSession.id;
    }

    this.seedFoundationalMemoriesIfEmpty();
  }

  private seedFoundationalMemoriesIfEmpty(): void {
    const existing = this.memoryRepo.listByProject(this.projectId, 5);
    if (existing.length > 0) return;

    const today = isoDay(new Date());
    const yesterday = isoDay(new Date(Date.now() - 86_400_000));

    this.memoryRepo.create({
      projectId: this.projectId,
      serverSessionId: this.activeSessionId,
      kind: 'manual',
      type: 'self_identity',
      title: 'Core Identity: MANASA-1 (මනස-1)',
      subtitle: 'Human-Like Trilingual Cognitive Brain on claude-mem',
      text: 'I am MANASA-1 (මනස-1), a living human-like cognitive AI powered by claude-mem persistent episodic/semantic memory, ACT-R synaptic reinforcement, a 62,962-parameter gated neural cortex, and a limbic emotion engine.',
      narrative: 'Awakened inside claude-mem with trilingual fluency in Singlish, සිංහල, and English.',
      facts: [
        'self.name = MANASA-1 (මනස-1)',
        'self.memory_engine = claude-mem SQLite FTS5 + ACT-R power-law decay',
        'self.languages = Singlish, සිංහල, English',
      ],
      concepts: ['MANASA-1', 'claude-mem', 'ACT-R', 'Neural Cortex', 'Trilingual'],
      metadata: {
        reinforcement_dates: JSON.stringify([yesterday, today]),
        slot: 'self.identity',
        emotionTag: 'curiosity',
      },
    });

    this.memoryRepo.create({
      projectId: this.projectId,
      serverSessionId: this.activeSessionId,
      kind: 'observation',
      type: 'cognitive_capability',
      title: 'Neuroplasticity & Human Memory Architecture',
      subtitle: 'Hippocampus + Prefrontal Cortex + Amygdala Loop',
      text: 'Every conversation strengthens recalled memories via Anderson & Schooler ACT-R power-law activation and forms new concept edges in the Knowledge Graph.',
      narrative: 'Just like human REM sleep, MANASA-1 can consolidate episodic observations, prune duplicates with TF-IDF cosine similarity, and restore mental energy.',
      facts: [
        'capability.memory = Persistent episodic & semantic recall across sessions',
        'capability.sleep = REM consolidation merges near-duplicate observations',
      ],
      concepts: ['Hippocampus', 'ACT-R', 'TF-IDF', 'REM Sleep', 'Knowledge Graph'],
      metadata: {
        reinforcement_dates: JSON.stringify([today]),
        emotionTag: 'focus',
      },
    });
  }

  /**
   * Extracts structured personal facts & taught reflexes naturally from Singlish, සිංහල, and English text!
   */
  public extractPersonalFacts(text: string): ExtractedFact[] {
    const trimmed = text.trim();
    const extracted: ExtractedFact[] = [];

    // 1. Taught Q&A Reflex:
    // - "Teach: when I say X, reply Y" / "Teach: X -> Y"
    // - "Ugannanna: X -> Y" / "උගන්වන්න: X -> Y"
    const arrowTeach = trimmed.match(
      /^(?:teach|ugannanna|igenaganna|උගන්වන්න|ඉගෙනගන්න)\s*[:-]?\s*(.+?)\s*(?:->|=>|::)\s*(.+)$/iu,
    );
    if (arrowTeach) {
      const trigger = arrowTeach[1].trim().replace(/^["']|["']$/g, '');
      const reply = arrowTeach[2].trim().replace(/^["']|["']$/g, '');
      if (trigger && reply) {
        extracted.push({
          slot: 'taught.reflex',
          subject: 'Learned Reflex',
          value: `When user says "${trigger}" → "${reply}"`,
          concepts: ['Learned Reflex', trigger.slice(0, 28)],
          rawText: trimmed,
          triggerPhrase: trigger,
          customReply: reply,
        });
      }
    }

    const sayReplyMatch = trimmed.match(
      /(?:when\s+i\s+say|mama\s+)["']?([^"']+?)["']?\s*(?:kiwwoth|kiyaddi|,?\s*reply|,?\s*say)\s+["']?([^"']+?)["']?(?:\s+kiyanna)?$/iu,
    );
    if (sayReplyMatch && extracted.length === 0) {
      const trigger = sayReplyMatch[1].trim();
      const reply = sayReplyMatch[2].trim();
      if (trigger && reply) {
        extracted.push({
          slot: 'taught.reflex',
          subject: 'Learned Reflex',
          value: `When user says "${trigger}" → "${reply}"`,
          concepts: ['Learned Reflex', trigger.slice(0, 28)],
          rawText: trimmed,
          triggerPhrase: trigger,
          customReply: reply,
        });
      }
    }

    // Question guard: interrogative utterances ("Mage nama mokakda?", "Where do I live?", "මගේ නම මොකක්ද?")
    // are memory RECALL queries, never declarative personal facts!
    const INTERROGATIVE_STOPWORDS =
      /\b(mokakda|mokada|monawada|kauda|kawuda|koheda|kawadada|mathakada|dannawada|what|who|where|which|remember\s+my)\b|(?:මොකක්ද|මොනවද|කවුද|කොහේද|මතකද|දන්නවද)/iu;
    const isQuestionQuery = trimmed.endsWith('?') || INTERROGATIVE_STOPWORDS.test(trimmed);

    if (isQuestionQuery && extracted.length === 0) {
      return extracted;
    }

    // 2. User Name (English, Singlish, Sinhala)
    const namePatterns = [
      /(?:my\s+name\s+is|call\s+me|i\s+am\s+called)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s'-]{1,28}?)(?:[.,!?;]|$|\s+(?:and|i\s+|from|machan|mchn|kiyala))/iu,
      /(?:mage\s+nama|mata\s+kiyanna)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s'-]{1,28}?)(?:[.,!?;]|$|\s+(?:kiyala|machan|mchn|mama|mathaka))/iu,
      /(?:මගේ\s+නම|මට\s+කියන්න)\s+([\u0D80-\u0DFFa-zA-Z][\u0D80-\u0DFFa-zA-Z\s]{1,28}?)(?:[.,!?;]|$|\s+(?:කියලා|මම|ඒක))/u,
    ];
    for (const re of namePatterns) {
      const m = trimmed.match(re);
      if (m && m[1]) {
        const cleanName = m[1]
          .trim()
          .replace(/\b(kiyala|mathaka|thiyaganna|machan|please|mokakda|koheda)\b/gi, '')
          .trim();
        if (cleanName.length >= 2 && cleanName.length <= 30 && !INTERROGATIVE_STOPWORDS.test(cleanName)) {
          extracted.push({
            slot: 'user.name',
            subject: 'User Name',
            value: cleanName,
            concepts: ['User Profile', cleanName],
            rawText: trimmed,
          });
          break;
        }
      }
    }

    // 3. User Location (English, Singlish, Sinhala)
    const locPatterns = [
      /(?:i\s+live\s+in|i\s+am\s+from|i'm\s+from)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s]{1,32}?)(?:[.,!?;]|$|\s+(?:and|i\s+))/iu,
      /(?:mama\s+inne|mage\s+gama)\s+([A-Za-z\u0D80-\u0DFF][A-Za-z\u0D80-\u0DFF\s]{1,32}?)(?:[.,!?;]|$|\s+(?:wala|eka|mama|machan))/iu,
      /(?:මම\s+ඉන්නේ|මගේ\s+ගම)\s+([\u0D80-\u0DFFa-zA-Z][\u0D80-\u0DFFa-zA-Z\s]{1,32}?)(?:[.,!?;]|$|\s+(?:වල|මම))/u,
    ];
    for (const re of locPatterns) {
      const m = trimmed.match(re);
      if (m && m[1]) {
        const loc = m[1].trim();
        if (loc.length >= 2 && !INTERROGATIVE_STOPWORDS.test(loc)) {
          extracted.push({
            slot: 'user.location',
            subject: 'User Location',
            value: loc,
            concepts: ['User Profile', 'Location', loc],
            rawText: trimmed,
          });
          break;
        }
      }
    }

    // 4. User Preferences / Likes
    const likePatterns = [
      /(?:i\s+(?:really\s+)?(?:love|like|enjoy)|my\s+favorite\s+[\w\s]+?\s+is)\s+([^.,!?;]{2,55})/iu,
      /(?:mama\s+(?:godak\s+)?(?:kamathi|asai)|mage\s+priyathama\s+\w+)\s+([^.,!?;]{2,55})/iu,
      /(?:මම\s+(?:ගොඩක්\s+)?(?:කැමති|ආසයි|ආස)|මගේ\s+ප්‍රියතම\s+[\u0D80-\u0DFF\w]+)\s+([^.,!?;]{2,55})/u,
    ];
    for (const re of likePatterns) {
      const m = trimmed.match(re);
      if (m && m[1]) {
        const pref = m[1]
          .trim()
          .replace(/\s+(?:kiyala\s+save.*|mathaka\s+thiyaganna.*)$/i, '')
          .replace(/\s+walata$/i, '')
          .trim();
        if (pref.length >= 2 && !INTERROGATIVE_STOPWORDS.test(pref)) {
          extracted.push({
            slot: 'user.likes',
            subject: 'User Preference',
            value: pref,
            concepts: ['User Preference', pref.split(/\s+/).slice(0, 3).join(' ')],
            rawText: trimmed,
          });
          break;
        }
      }
    }

    // 5. User Goal / Ambition
    const goalPatterns = [
      /(?:my\s+goal\s+is|i\s+want\s+to\s+build|my\s+dream\s+is)\s+([^.,!?;]{3,75})/iu,
      /(?:mage\s+goal\s+eka|mage\s+ilakkaya)\s+([^.,!?;]{3,75})/iu,
      /(?:මගේ\s+ඉලක්කය|මගේ\s+සිහිනය)\s+([^.,!?;]{3,75})/u,
    ];
    for (const re of goalPatterns) {
      const m = trimmed.match(re);
      if (m && m[1]) {
        extracted.push({
          slot: 'user.goal',
          subject: 'User Goal',
          value: m[1].trim(),
          concepts: ['User Goal', 'Ambition'],
          rawText: trimmed,
        });
        break;
      }
    }

    // 6. Explicit "Remember that / Mathaka thiyaganna / මතක තියාගන්න"
    if (extracted.length === 0) {
      const explicitMem = trimmed.match(
        /^(?:please\s+)?(?:remember(?:\s+that|\s+this\s+fact)?|mathaka\s+thiyaganna|save\s+karaganna|මතක\s+තියාගන්න)\s*[:-]?\s*(.{4,180})$/iu,
      );
      if (explicitMem && explicitMem[1]) {
        const val = explicitMem[1].trim();
        extracted.push({
          slot: 'custom.fact',
          subject: 'Explicit Memory',
          value: val,
          concepts: ['Semantic Memory', ...normalizeTokens(val).slice(0, 3)],
          rawText: trimmed,
        });
      }
    }

    return extracted;
  }

  /**
   * Stores an extracted personal fact or taught reflex into claude-mem `memory_items` (updating existing singleton slots like user.name).
   */
  public storeFact(fact: ExtractedFact, emotionTag = 'trust'): MemoryItem {
    const singletonSlots = new Set(['user.name', 'user.location', 'user.goal']);
    const allItems = this.memoryRepo.listByProject(this.projectId, 200);

    if (singletonSlots.has(fact.slot)) {
      const existing = allItems.find(it => it.metadata?.slot === fact.slot);
      if (existing) {
        const prevDates = parseReinforcementDates(
          typeof existing.metadata?.reinforcement_dates === 'string'
            ? existing.metadata.reinforcement_dates
            : null,
        );
        const updatedDates = appendReinforcement(prevDates, new Date());
        const updated = this.memoryRepo.update(existing.id, {
          title: `${fact.subject}: ${fact.value}`,
          text: fact.rawText,
          facts: [`${fact.slot} = ${fact.value}`],
          concepts: fact.concepts,
          metadata: {
            ...existing.metadata,
            slot: fact.slot,
            value: fact.value,
            emotionTag,
            reinforcement_dates: JSON.stringify(updatedDates),
          },
        });
        if (updated) return updated;
      }
    }

    const today = isoDay(new Date());
    const item = this.memoryRepo.create({
      projectId: this.projectId,
      serverSessionId: this.activeSessionId,
      kind: 'manual',
      type: fact.slot === 'taught.reflex' ? 'learned_reflex' : 'personal_fact',
      title: `${fact.subject}: ${fact.value.slice(0, 72)}`,
      subtitle: fact.slot,
      text: fact.rawText,
      narrative: `Encoded into long-term Hippocampal memory (${fact.slot}).`,
      facts: [`${fact.slot} = ${fact.value}`],
      concepts: fact.concepts,
      metadata: {
        slot: fact.slot,
        value: fact.value,
        triggerPhrase: fact.triggerPhrase ?? null,
        customReply: fact.customReply ?? null,
        emotionTag,
        reinforcement_dates: JSON.stringify([today]),
      },
    });

    this.memoryRepo.addSource({
      memoryItemId: item.id,
      sourceType: 'manual',
      metadata: { slot: fact.slot },
    });

    return item;
  }

  /**
   * Stores an episodic conversation memory (`observation`) in claude-mem, skipping trivial 1-word greetings.
   */
  public storeEpisodicTurn(
    userMessage: string,
    assistantReply: string,
    intent: string,
    emotionTag: string,
    concepts: string[],
  ): MemoryItem | null {
    if (userMessage.trim().length < 8 && intent === 'greeting') {
      return null;
    }

    const today = isoDay(new Date());
    const item = this.memoryRepo.create({
      projectId: this.projectId,
      serverSessionId: this.activeSessionId,
      kind: 'observation',
      type: intent,
      title: userMessage.slice(0, 76),
      subtitle: `Intent: ${intent} • Emotion: ${emotionTag}`,
      text: userMessage,
      narrative: assistantReply.slice(0, 260),
      facts: [],
      concepts: [...new Set([intent, ...concepts.slice(0, 4)])],
      metadata: {
        emotionTag,
        reinforcement_dates: JSON.stringify([today]),
      },
    });

    this.eventsRepo.create({
      projectId: this.projectId,
      serverSessionId: this.activeSessionId,
      sourceType: 'api',
      eventType: `cognitive.${intent}`,
      payload: {
        userMessage: userMessage.slice(0, 200),
        emotionTag,
        memoryId: item.id,
      },
      occurredAtEpoch: Date.now(),
    });

    return item;
  }

  /**
   * Checks if the user's message matches a taught Q&A reflex stored in claude-mem.
   */
  public findMatchingReflex(userText: string): { reply: string; memory: RecalledMemory } | null {
    const items = this.memoryRepo.listByProject(this.projectId, 200);
    const reflexes = items.filter(it => it.type === 'learned_reflex' && it.metadata?.triggerPhrase);
    if (reflexes.length === 0) return null;

    const queryTokens = normalizeTokens(userText);
    const idfFn = buildIdfFn(() => 1, Math.max(10, items.length));

    let best: { item: MemoryItem; sim: number } | null = null;
    for (const item of reflexes) {
      const trigger = String(item.metadata.triggerPhrase ?? '');
      const trigTokens = normalizeTokens(trigger);
      const exactSub = userText.toLowerCase().includes(trigger.toLowerCase());
      const sim = exactSub ? 0.98 : tfidfCosine(queryTokens, trigTokens, idfFn);
      if (sim >= 0.72 && (!best || sim > best.sim)) {
        best = { item, sim };
      }
    }

    if (!best) return null;
    this.reinforceMemoryItem(best.item.id);
    return {
      reply: String(best.item.metadata.customReply ?? ''),
      memory: this.toRecalledMemory(best.item, best.sim),
    };
  }

  /**
   * Hybrid Hippocampal Recall:
   * 1. SQLite FTS5 search (`MemoryItemsRepository.search`)
   * 2. Corpus-wide IDF-weighted TF-IDF cosine semantic similarity (`tfidfCosine`)
   * 3. ACT-R power-law base-level activation (`blendedScore` from `src/services/reinforcement/rank.ts`)
   * 4. Automatic synaptic reinforcement (`appendReinforcement`) on top recalled memories!
   */
  public recallMemories(query: string, limit = 6, reinforceTop = true): RecalledMemory[] {
    const allItems = this.memoryRepo.listByProject(this.projectId, 250);
    if (allItems.length === 0) return [];

    // FTS5 hits boost
    const ftsIds = new Set<string>();
    try {
      const ftsHits = this.memoryRepo.search(this.projectId, query, 25);
      for (const hit of ftsHits) ftsIds.add(hit.id);
    } catch {
      // Safe fallback if query contains unusual FTS syntax
    }

    // Build real corpus document frequency table for claude-mem's `buildIdfFn`
    const docFreq = new Map<string, number>();
    const itemTokensMap = new Map<string, string[]>();
    for (const item of allItems) {
      const combinedText = [
        item.title ?? '',
        item.text ?? '',
        item.narrative ?? '',
        item.facts.join(' '),
        item.concepts.join(' '),
      ].join(' ');
      const toks = normalizeTokens(combinedText);
      itemTokensMap.set(item.id, toks);
      for (const uniq of new Set(toks)) {
        docFreq.set(uniq, (docFreq.get(uniq) ?? 0) + 1);
      }
    }

    const idfFn = buildIdfFn(tok => docFreq.get(tok) ?? 0, allItems.length);
    const queryTokens = normalizeTokens(query);
    const today = new Date();

    const scored: RecalledMemory[] = allItems.map(item => {
      const docToks = itemTokensMap.get(item.id) ?? [];
      const cosine = queryTokens.length > 0 ? tfidfCosine(queryTokens, docToks, idfFn) : 0;
      const ftsBoost = ftsIds.has(item.id) ? 0.25 : 0;
      const manualFactBoost = item.kind === 'manual' ? 0.14 : item.kind === 'summary' ? 0.1 : 0;

      const rawDates =
        typeof item.metadata?.reinforcement_dates === 'string'
          ? item.metadata.reinforcement_dates
          : null;
      const actR = blendedScore(
        {
          created_at_epoch: item.createdAtEpoch,
          reinforcement_dates: rawDates,
        },
        today,
        ACT_R_ALPHA,
      );

      const combined = cosine * 0.62 + ftsBoost + manualFactBoost + Math.min(0.45, actR * 0.22);
      return this.toRecalledMemory(item, cosine, actR, combined);
    });

    scored.sort((a, b) => b.combinedScore - a.combinedScore || b.updatedAtEpoch - a.updatedAtEpoch);
    const top = scored.slice(0, limit);

    if (reinforceTop) {
      for (const mem of top.slice(0, 2)) {
        if (mem.semanticSimilarity > 0.18) {
          this.reinforceMemoryItem(mem.id);
        }
      }
    }

    return top;
  }

  public getUserProfileMap(): Record<string, string> {
    const profile: Record<string, string> = {};
    const items = this.memoryRepo.listByProject(this.projectId, 200);
    for (const item of items) {
      if (item.kind === 'manual' && typeof item.metadata?.slot === 'string' && item.metadata?.value) {
        if (!(item.metadata.slot in profile)) {
          profile[item.metadata.slot] = String(item.metadata.value);
        }
      }
    }
    return profile;
  }

  public listMemories(kindFilter?: string, query?: string): RecalledMemory[] {
    let items: MemoryItem[];
    if (query && query.trim()) {
      return this.recallMemories(query.trim(), 50, false).filter(
        m => !kindFilter || kindFilter === 'all' || m.kind === kindFilter,
      );
    }
    items = this.memoryRepo.listByProject(this.projectId, 150);
    if (kindFilter && kindFilter !== 'all') {
      items = items.filter(it => it.kind === kindFilter);
    }
    const today = new Date();
    return items.map(item => {
      const rawDates =
        typeof item.metadata?.reinforcement_dates === 'string'
          ? item.metadata.reinforcement_dates
          : null;
      const actR = blendedScore(
        { created_at_epoch: item.createdAtEpoch, reinforcement_dates: rawDates },
        today,
        ACT_R_ALPHA,
      );
      return this.toRecalledMemory(item, 0, actR, actR);
    });
  }

  public reinforceMemoryItem(id: string, simulatedFutureDate?: Date): RecalledMemory | null {
    const existing = this.memoryRepo.getById(id);
    if (!existing) return null;

    const currentDates = parseReinforcementDates(
      typeof existing.metadata?.reinforcement_dates === 'string'
        ? existing.metadata.reinforcement_dates
        : null,
    );
    // Allow interactive UI boost even within same UTC day by adding synthetic spaced trace if already reinforced today
    const targetDate = simulatedFutureDate ?? new Date();
    let nextDates = appendReinforcement(currentDates, targetDate);
    if (nextDates === currentDates) {
      const spacedEpoch = Date.now() - (currentDates.length + 1) * 86_400_000;
      nextDates = appendReinforcement(currentDates, new Date(spacedEpoch));
    }

    const boostCount = Number(existing.metadata?.manual_boosts ?? 0) + 1;
    const updated = this.memoryRepo.update(id, {
      metadata: {
        ...existing.metadata,
        reinforcement_dates: JSON.stringify(nextDates),
        manual_boosts: boostCount,
      },
    });
    if (!updated) return null;

    const actR = blendedScore(
      {
        created_at_epoch: updated.createdAtEpoch,
        reinforcement_dates: JSON.stringify(nextDates),
      },
      new Date(),
      ACT_R_ALPHA,
    ) + boostCount * 0.08;

    return this.toRecalledMemory(updated, 1, actR, actR);
  }

  public deleteMemoryItem(id: string): boolean {
    const existing = this.memoryRepo.getById(id);
    if (!existing) return false;
    this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(id);
    return true;
  }

  /**
   * REM Sleep Consolidation:
   * - Scans episodic observations with `tfidfCosine` to prune near-duplicates (>0.82 similarity)
   * - Reinforces personal facts via ACT-R
   * - Synthesizes a long-term `summary` MemoryItem in claude-mem!
   */
  public consolidateRemSleep(energyAfter: number): ConsolidationReport {
    const allItems = this.memoryRepo.listByProject(this.projectId, 200);
    const observations = allItems.filter(it => it.kind === 'observation');
    const manualFacts = allItems.filter(it => it.kind === 'manual');

    const idfFn = buildIdfFn(() => 1, Math.max(10, observations.length));
    const toDelete = new Set<string>();
    let mergedDuplicates = 0;

    for (let i = 0; i < observations.length; i++) {
      if (toDelete.has(observations[i].id)) continue;
      const tokA = normalizeTokens(`${observations[i].title ?? ''} ${observations[i].text ?? ''}`);
      for (let j = i + 1; j < observations.length; j++) {
        if (toDelete.has(observations[j].id)) continue;
        const tokB = normalizeTokens(`${observations[j].title ?? ''} ${observations[j].text ?? ''}`);
        const sim = tfidfCosine(tokA, tokB, idfFn);
        if (sim >= 0.82) {
          toDelete.add(observations[j].id);
          this.reinforceMemoryItem(observations[i].id);
          mergedDuplicates += 1;
        }
      }
    }

    for (const dupId of toDelete) {
      this.deleteMemoryItem(dupId);
    }

    let reinforcedMemories = 0;
    for (const fact of manualFacts.slice(0, 10)) {
      this.reinforceMemoryItem(fact.id);
      reinforcedMemories += 1;
    }

    const survivingObs = observations.filter(o => !toDelete.has(o.id));
    const topConcepts = [
      ...new Set(
        [...manualFacts, ...survivingObs.slice(0, 8)].flatMap(it => it.concepts),
      ),
    ].slice(0, 6);

    const factHighlights = manualFacts
      .slice(0, 5)
      .map(f => f.title ?? f.text ?? '')
      .filter(Boolean);

    const summaryTitle = `REM Memory Consolidation (${new Date().toISOString().slice(11, 16)} UTC)`;
    const summaryNarrative =
      factHighlights.length > 0
        ? `Consolidated ${survivingObs.length} episodic experiences and reinforced ${reinforcedMemories} core semantic memories (${factHighlights.join(' • ')}). Pruned ${mergedDuplicates} redundant synaptic traces.`
        : `Consolidated ${survivingObs.length} episodic experiences and pruned ${mergedDuplicates} redundant synaptic traces. Neural energy restored to ${energyAfter}%.`;

    const summaryItem = this.memoryRepo.create({
      projectId: this.projectId,
      serverSessionId: this.activeSessionId,
      kind: 'summary',
      type: 'rem_consolidation',
      title: summaryTitle,
      subtitle: `${survivingObs.length} episodes • ${reinforcedMemories} facts reinforced`,
      text: summaryNarrative,
      narrative: summaryNarrative,
      facts: factHighlights,
      concepts: ['REM Consolidation', ...topConcepts],
      metadata: {
        reinforcement_dates: JSON.stringify([isoDay(new Date())]),
        emotionTag: 'calm',
      },
    });

    return {
      consolidatedCount: survivingObs.length,
      mergedDuplicates,
      reinforcedMemories,
      summaryId: summaryItem.id,
      summaryTitle,
      summaryNarrative,
      energyAfter,
    };
  }

  /**
   * Builds the live Knowledge Graph (Self, User, Personal Facts, Episodic Memories, Summaries, & Concept Hubs).
   */
  public buildKnowledgeGraph(): KnowledgeGraphData {
    const items = this.memoryRepo.listByProject(this.projectId, 120);
    const profile = this.getUserProfileMap();
    const nodes: KnowledgeGraphNode[] = [];
    const edges: KnowledgeGraphEdge[] = [];
    const nodeIds = new Set<string>();

    const addNode = (node: KnowledgeGraphNode) => {
      if (!nodeIds.has(node.id)) {
        nodeIds.add(node.id);
        nodes.push(node);
      }
    };

    addNode({
      id: 'self:manasa',
      label: 'MANASA-1 (මනස)',
      category: 'self',
      strength: 2.0,
      val: 22,
      subtitle: 'Living Cognitive Brain',
    });

    const userName = profile['user.name'] ? `User: ${profile['user.name']}` : 'Human Companion';
    addNode({
      id: 'entity:user',
      label: userName,
      category: 'user',
      strength: 1.8,
      val: 18,
      subtitle: profile['user.location'] ? `Location: ${profile['user.location']}` : 'Active Bond',
    });

    edges.push({
      source: 'self:manasa',
      target: 'entity:user',
      relation: 'social_bond',
      weight: 1.0,
    });

    const today = new Date();
    let sumActR = 0;
    const conceptFreq = new Map<string, string[]>();

    for (const item of items.slice(0, 42)) {
      const rawDates =
        typeof item.metadata?.reinforcement_dates === 'string'
          ? item.metadata.reinforcement_dates
          : null;
      const boostCount = Number(item.metadata?.manual_boosts ?? 0);
      const actR =
        blendedScore(
          { created_at_epoch: item.createdAtEpoch, reinforcement_dates: rawDates },
          today,
          ACT_R_ALPHA,
        ) +
        boostCount * 0.08;
      sumActR += actR;

      const memNodeId = `mem:${item.id}`;
      const category: KnowledgeGraphNode['category'] =
        item.kind === 'manual' ? 'fact' : item.kind === 'summary' ? 'summary' : 'episode';

      addNode({
        id: memNodeId,
        label: (item.title ?? item.text ?? 'Memory').slice(0, 34),
        category,
        strength: Number(actR.toFixed(3)),
        val: category === 'fact' ? 13 : category === 'summary' ? 14 : 9,
        subtitle: (item.narrative ?? item.text ?? '').slice(0, 90),
        createdAtEpoch: item.createdAtEpoch,
      });

      if (category === 'fact' && String(item.metadata?.slot ?? '').startsWith('user.')) {
        edges.push({
          source: 'entity:user',
          target: memNodeId,
          relation: 'attribute',
          weight: Math.min(1, 0.55 + actR * 0.3),
        });
      } else {
        edges.push({
          source: 'self:manasa',
          target: memNodeId,
          relation: category === 'summary' ? 'consolidated' : 'remembers',
          weight: Math.min(1, 0.45 + actR * 0.3),
        });
      }

      for (const rawConcept of item.concepts.slice(0, 3)) {
        const c = rawConcept.trim();
        if (!c || c.length < 2) continue;
        const list = conceptFreq.get(c) ?? [];
        list.push(memNodeId);
        conceptFreq.set(c, list);
      }
    }

    // Add shared Concept Hubs
    for (const [concept, linkedMemIds] of conceptFreq.entries()) {
      if (nodes.length >= 68) break;
      const conceptId = `concept:${concept.toLowerCase()}`;
      addNode({
        id: conceptId,
        label: `#${concept.slice(0, 22)}`,
        category: 'concept',
        strength: Number((0.6 + linkedMemIds.length * 0.2).toFixed(2)),
        val: Math.min(15, 7 + linkedMemIds.length * 2),
        subtitle: `Linked across ${linkedMemIds.length} memories`,
      });
      for (const memId of linkedMemIds.slice(0, 6)) {
        edges.push({
          source: memId,
          target: conceptId,
          relation: 'concept',
          weight: 0.5,
        });
      }
    }

    const manualFacts = items.filter(i => i.kind === 'manual').length;
    const episodicMemories = items.filter(i => i.kind === 'observation').length;
    const consolidatedSummaries = items.filter(i => i.kind === 'summary').length;

    return {
      nodes,
      edges,
      stats: {
        totalMemories: items.length,
        manualFacts,
        episodicMemories,
        consolidatedSummaries,
        conceptCount: conceptFreq.size,
        avgActRStrength: items.length > 0 ? Number((sumActR / Math.min(items.length, 42)).toFixed(3)) : 0.7,
      },
    };
  }

  private toRecalledMemory(
    item: MemoryItem,
    cosine: number,
    precomputedActR?: number,
    precomputedCombined?: number,
  ): RecalledMemory {
    const rawDates =
      typeof item.metadata?.reinforcement_dates === 'string'
        ? item.metadata.reinforcement_dates
        : null;
    const dates = parseReinforcementDates(rawDates);
    const boostCount = Number(item.metadata?.manual_boosts ?? 0);
    const actR =
      precomputedActR ??
      blendedScore(
        { created_at_epoch: item.createdAtEpoch, reinforcement_dates: rawDates },
        new Date(),
        ACT_R_ALPHA,
      ) +
        boostCount * 0.08;

    return {
      id: item.id,
      kind: item.kind,
      type: item.type,
      title: item.title ?? 'Untitled Memory',
      text: item.text ?? item.narrative ?? '',
      facts: item.facts,
      concepts: item.concepts,
      actRScore: Number(actR.toFixed(3)),
      semanticSimilarity: Number(cosine.toFixed(3)),
      combinedScore: Number((precomputedCombined ?? actR).toFixed(3)),
      reinforcementDates: dates,
      createdAtEpoch: item.createdAtEpoch,
      updatedAtEpoch: item.updatedAtEpoch,
      emotionTag: typeof item.metadata?.emotionTag === 'string' ? item.metadata.emotionTag : undefined,
    };
  }
}
