// SPDX-License-Identifier: Apache-2.0

export type SupportedLanguage = 'singlish' | 'sinhala' | 'english';
export type LanguagePreference = 'auto' | SupportedLanguage;

export const COGNITIVE_INTENTS = [
  'greeting',
  'identity_self',
  'teach_fact',
  'recall_memory',
  'emotional_share',
  'reasoning_problem',
  'creative_ideation',
  'coding_tech',
  'gratitude_praise',
  'curious_question',
  'task_planning',
  'farewell',
  'meta_memory_sleep',
  'casual_chat',
] as const;

export type CognitiveIntent = (typeof COGNITIVE_INTENTS)[number];

export interface IntentScore {
  intent: CognitiveIntent;
  probability: number;
  labelEn: string;
  labelSi: string;
}

export interface AffectPrediction {
  /** Emotional valence from -1 (distressed/negative) to +1 (joyful/positive) */
  valence: number;
  /** Physiological arousal / intensity from 0 (calm) to 1 (excited/urgent) */
  arousal: number;
  /** Social warmth / friendliness from 0 to 1 */
  warmth: number;
  /** Epistemic curiosity drive from 0 to 1 */
  curiosity: number;
}

export interface LanguageAnalysis {
  detected: SupportedLanguage;
  confidence: number;
  sinhalaRatio: number;
  singlishScore: number;
  englishScore: number;
  normalizedTokens: string[];
  activeFeatureCount: number;
}

export interface NeuralForwardResult {
  topIntent: CognitiveIntent;
  confidence: number;
  entropy: number;
  intentRanking: IntentScore[];
  affect: AffectPrediction;
  /** 64-dimensional cortical thought bottleneck activation (-1..1) */
  cortex64: number[];
  /** Summary norm of layers for telemetry */
  layerNorms: {
    inputActiveFeatures: number;
    embedding96Norm: number;
    gated96Norm: number;
    cortex64Norm: number;
  };
}

export interface TrainingSample {
  text: string;
  language: SupportedLanguage;
  intent: CognitiveIntent;
  affect: [number, number, number, number]; // [valence, arousal, warmth, curiosity]
}

export interface TrainingEpochMetric {
  epoch: number;
  totalLoss: number;
  intentLoss: number;
  affectLoss: number;
  accuracy: number;
  timestamp: number;
}

export interface NeuralModelStats {
  architecture: string;
  inputDim: number;
  embeddingDim: number;
  gatedDim: number;
  bottleneckDim: number;
  numIntents: number;
  totalParameters: number;
  trainedEpochs: number;
  onlineUpdates: number;
  corpusSize: number;
  lastLoss: number;
  lastAccuracy: number;
  history: TrainingEpochMetric[];
}

export interface EmotionVector {
  joy: number;       // 0..1
  curiosity: number; // 0..1
  empathy: number;   // 0..1
  trust: number;     // 0..1
  calm: number;      // 0..1
  focus: number;     // 0..1
}

export interface Neuromodulators {
  dopamine: number;       // Reward, novelty & learning plasticity (0..1)
  serotonin: number;      // Mood stability & contentment (0..1)
  oxytocin: number;       // Human rapport & social bond (0..1)
  norepinephrine: number; // Alertness & executive focus (0..1)
}

export interface LimbicState {
  emotions: EmotionVector;
  neuromodulators: Neuromodulators;
  energy: number; // 0..100
  dominantEmotion: keyof EmotionVector;
  moodLabel: {
    english: string;
    sinhala: string;
    singlish: string;
  };
  voiceProsody: {
    pitch: number; // 0.8 .. 1.25
    rate: number;  // 0.85 .. 1.15
  };
  interactionCount: number;
}

export interface ExtractedFact {
  slot: string; // e.g. 'user.name', 'user.location', 'user.goal', 'user.likes', 'custom.fact', 'taught.reflex'
  subject: string;
  value: string;
  concepts: string[];
  rawText: string;
  triggerPhrase?: string;
  customReply?: string;
}

export interface RecalledMemory {
  id: string;
  kind: 'observation' | 'summary' | 'prompt' | 'manual';
  type: string;
  title: string;
  text: string;
  facts: string[];
  concepts: string[];
  actRScore: number;
  semanticSimilarity: number;
  combinedScore: number;
  reinforcementDates: string[];
  createdAtEpoch: number;
  updatedAtEpoch: number;
  emotionTag?: string;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  category: 'self' | 'user' | 'fact' | 'episode' | 'concept' | 'summary';
  strength: number;
  val: number;
  subtitle?: string;
  createdAtEpoch?: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relation: string;
  weight: number;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  stats: {
    totalMemories: number;
    manualFacts: number;
    episodicMemories: number;
    consolidatedSummaries: number;
    conceptCount: number;
    avgActRStrength: number;
  };
}

export interface InnerThoughtStep {
  stage: 'perception' | 'neural_cortex' | 'hippocampus_memory' | 'limbic_affect' | 'executive_synthesis';
  titleEn: string;
  titleSi: string;
  summary: string;
  metrics?: Record<string, string | number>;
  durationMs: number;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  language: SupportedLanguage;
  timestamp: number;
  innerThoughts?: InnerThoughtStep[];
  neural?: {
    topIntent: CognitiveIntent;
    confidence: number;
    intentRanking: IntentScore[];
    affect: AffectPrediction;
    cortex64: number[];
  };
  recalledMemories?: RecalledMemory[];
  learnedFacts?: ExtractedFact[];
  limbicSnapshot?: LimbicState;
  usedExternalLlm?: boolean;
  providerName?: string;
}

export interface ExternalCortexSettings {
  enabled: boolean;
  provider: 'none' | 'openai' | 'gemini' | 'anthropic' | 'openrouter';
  apiKey: string;
  model: string;
}

export interface ConsolidationReport {
  consolidatedCount: number;
  mergedDuplicates: number;
  reinforcedMemories: number;
  summaryId: string | null;
  summaryTitle: string;
  summaryNarrative: string;
  energyAfter: number;
}
