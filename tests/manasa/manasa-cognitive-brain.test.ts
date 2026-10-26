// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { ManasaCognitiveAgent } from '../../src/manasa/cognition/cognitive-agent.js';
import { ManasaNeuralCortex } from '../../src/manasa/model/neural-cortex.js';
import { analyzeLanguage, normalizeTokens } from '../../src/manasa/model/tokenizer.js';

describe('MANASA-1 Human-Like Cognitive Brain & claude-mem Integration', () => {
  it('accurately detects Singlish, සිංහල, and English and normalizes Singlish variants', () => {
    const sg = analyzeLanguage('Khmda mchn ada wade kohomada?');
    expect(sg.detected).toBe('singlish');
    expect(normalizeTokens('khmda mchn')).toEqual(['kohomada', 'machan']);

    const si = analyzeLanguage('ආයුබෝවන්! ඔයාගේ මොළය වැඩ කරන්නේ කොහොමද?');
    expect(si.detected).toBe('sinhala');

    const en = analyzeLanguage('Hello friend, can you explain how neural memory works?');
    expect(en.detected).toBe('english');
  });

  it('trains the 62,962-parameter Gated Neural Cortex and adapts online via backpropagation', () => {
    const cortex = new ManasaNeuralCortex();
    const statsBefore = cortex.getStats();
    expect(statsBefore.totalParameters).toBeGreaterThan(60_000);
    expect(statsBefore.lastAccuracy).toBeGreaterThan(0.95);

    const pred = cortex.predict('Mata ada godak mahansi saha dukai machan');
    expect(pred.topIntent).toBe('emotional_share');
    expect(pred.affect.valence).toBeLessThan(0);
    expect(pred.cortex64).toHaveLength(64);

    const sumProbs = pred.intentRanking.reduce((acc, item) => acc + item.probability, 0);
    expect(Math.abs(sumProbs - 1)).toBeLessThan(0.01);

    // Online neuroplasticity on a brand-new custom phrase
    const afterOnline = cortex.learnOnlineSample('Zeta-99 protocol activate karamu', 'task_planning');
    expect(afterOnline.topIntent).toBe('task_planning');
  });

  it('encodes personal facts into claude-mem SQLite, guards against question overwrites, and recalls with ACT-R', async () => {
    const agent = new ManasaCognitiveAgent({ dbPath: ':memory:' });

    const turn1 = await agent.chat(
      'Mage nama Rusindu, mama inne Pita Kotte, mage goal eka aluth AI startup ekak hadana eka.',
    );
    expect(turn1.assistantTurn.learnedFacts?.length).toBeGreaterThanOrEqual(3);
    expect(turn1.assistantTurn.innerThoughts).toHaveLength(5);

    // Asking a recall question must NOT overwrite user.name!
    const turn2 = await agent.chat('Mage nama mokakda saha mama koheda inne kiyala oyata mathakada?');
    expect(turn2.assistantTurn.content).toContain('Rusindu');
    expect(turn2.assistantTurn.content).toContain('Pita Kotte');

    const profile = agent.hippocampus.getUserProfileMap();
    expect(profile['user.name']).toBe('Rusindu');
    expect(profile['user.location']).toBe('Pita Kotte');

    // ACT-R boost increases synaptic score
    const memories = agent.hippocampus.listMemories('manual');
    const nameMem = memories.find(m => m.title.includes('Rusindu'));
    expect(nameMem).toBeDefined();
    const boosted = agent.hippocampus.reinforceMemoryItem(nameMem!.id);
    expect(boosted!.actRScore).toBeGreaterThan(nameMem!.actRScore);
  });

  it('supports taught custom reflexes, mathematical reasoning, Knowledge Graph, and REM sleep consolidation', async () => {
    const agent = new ManasaCognitiveAgent({ dbPath: ':memory:' });

    agent.teachExplicit({
      phrase: 'Jaya wewa manasa',
      intent: 'greeting',
      customReply: 'Jaya wewa machan! Api ekathu wela supirima deyak hadamu! 🚀',
    });

    const reflexTurn = await agent.chat('Jaya wewa manasa');
    expect(reflexTurn.assistantTurn.content).toContain('Api ekathu wela supirima deyak hadamu');

    const mathTurn = await agent.chat('Solve step by step: (125 * 8) + 250');
    expect(mathTurn.assistantTurn.content).toContain('1250');

    // Duplicate episodic observations get pruned during REM sleep consolidation
    agent.hippocampus.storeEpisodicTurn(
      'Exploring neural hippocampus memory graph architecture today',
      'Ack 1',
      'curious_question',
      'curiosity',
      ['hippocampus', 'graph'],
    );
    agent.hippocampus.storeEpisodicTurn(
      'Exploring neural hippocampus memory graph architecture today',
      'Ack 2',
      'curious_question',
      'curiosity',
      ['hippocampus', 'graph'],
    );

    const { report, limbic, graph } = agent.runRemConsolidation();
    expect(report.mergedDuplicates).toBeGreaterThanOrEqual(1);
    expect(limbic.energy).toBe(100);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.edges.length).toBeGreaterThanOrEqual(3);
  });
});
