/**
 * Types for Sleep Agent memory consolidation system
 * Inspired by Titans paper - background consolidation of memory representations
 */

// ============================================================================
// Priority Types (P1: Multi-Tier Consolidation)
// ============================================================================

/**
 * Priority weights for observation types
 * Higher weight = higher priority for consolidation
 *
 * Inspired by Nested Learning: different memory types need different update frequencies.
 * bugfix: Critical fixes should consolidate fastest (like αs in Titans - fast timescale)
 * decision: Architectural decisions are important context
 * feature: New functionality
 * refactor: Code improvements
 * change: General modifications
 * discovery: Learnings can wait (like αl in Titans - slow timescale)
 */
export const OBSERVATION_PRIORITY_WEIGHTS: Record<string, number> = {
  bugfix: 1.0,      // Highest priority - critical fixes
  decision: 0.9,    // High priority - architectural decisions
  feature: 0.7,     // Medium priority - new functionality
  refactor: 0.6,    // Medium priority - code improvements
  change: 0.5,      // Lower priority - general modifications
  discovery: 0.4,   // Lower priority - learnings/exploration
  // Default for unknown types
  default: 0.5,
};

/**
 * Get priority weight for an observation type
 */
export function getObservationPriority(type: string): number {
  return OBSERVATION_PRIORITY_WEIGHTS[type] ?? OBSERVATION_PRIORITY_WEIGHTS.default;
}

/**
 * Priority tier based on weight
 */
export type PriorityTier = 'critical' | 'high' | 'medium' | 'low';

/**
 * Get priority tier from weight
 */
export function getPriorityTier(weight: number): PriorityTier {
  if (weight >= 0.9) return 'critical';
  if (weight >= 0.7) return 'high';
  if (weight >= 0.5) return 'medium';
  return 'low';
}

/**
 * Priority configuration for consolidation
 */
export interface PriorityConfig {
  enabled: boolean;
  /**
   * Boost factor for high-priority observations.
   * Lowers the confidence threshold by this factor for higher priority types.
   * E.g., 0.1 means bugfix (1.0 priority) gets 0.1 lower threshold
   */
  confidenceBoostFactor: number;
  /**
   * Process high-priority observations first in batch operations
   */
  priorityOrdering: boolean;
}

/**
 * Default priority configuration
 */
export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = {
  enabled: true,
  confidenceBoostFactor: 0.1,
  priorityOrdering: true,
};

// ============================================================================
// Memory Tier Types (P2: Memory Hierarchical / CMS)
// ============================================================================

/**
 * Memory tier classification based on Nested Learning's Continuum Memory Systems
 * Different tiers update at different frequencies and have different retention policies
 *
 * Inspired by CMS: Memory is a spectrum, not binary (short-term vs long-term)
 */
export type MemoryTier = 'core' | 'working' | 'archive' | 'ephemeral';

/**
 * Memory tier with descriptions
 */
export const MEMORY_TIER_DESCRIPTIONS: Record<MemoryTier, string> = {
  core: 'Core decisions, never forget',
  working: 'Working memory, actively used',
  archive: 'Archived, can be recalled',
  ephemeral: 'Ephemeral, can be cleaned',
};

/**
 * Get memory tier from string
 */
export function getMemoryTier(tier: string | null | undefined): MemoryTier {
  if (tier && ['core', 'working', 'archive', 'ephemeral'].includes(tier)) {
    return tier as MemoryTier;
  }
  return 'working'; // Default tier
}

/**
 * Memory tier transition rules
 * When should observations move between tiers?
 */
export interface MemoryTierTransition {
  from: MemoryTier;
  to: MemoryTier;
  condition: 'superseded' | 'idle_long' | 'reference_count' | 'manual' | 'age';
  description: string;
}

/**
 * Configuration for memory tier management
 */
export interface MemoryTierConfig {
  enabled: boolean;

  /**
   * Days after which 'working' observations move to 'archive' if not accessed
   */
  workingToArchiveDays: number; // Default: 30

  /**
   * Days after which 'archive' observations become candidates for cleanup
   */
  archiveToEphemeralDays: number; // Default: 180

  /**
   * Reference count threshold for 'core' tier
   * Observations referenced more than this times are considered core
   */
  coreReferenceThreshold: number; // Default: 5

  /**
   * Auto-classify observations on creation
   */
  autoClassifyOnCreation: boolean; // Default: true

  /**
   * Re-classify during sleep cycles
   */
  reclassifyOnSleepCycle: boolean; // Default: true
}

/**
 * Default memory tier configuration
 */
export const DEFAULT_MEMORY_TIER_CONFIG: MemoryTierConfig = {
  enabled: true,
  workingToArchiveDays: 30,
  archiveToEphemeralDays: 180,
  coreReferenceThreshold: 5,
  autoClassifyOnCreation: true,
  reclassifyOnSleepCycle: true,
};

/**
 * Classification result for an observation
 */
export interface MemoryTierClassification {
  observationId: number;
  tier: MemoryTier;
  reason: string;
  confidence: number; // 0-1, how confident in this classification
  factors: {
    type: string; // e.g., 'decision', 'bugfix'
    referenceCount: number;
    daysSinceCreation: number;
    daysSinceLastAccess: number;
    superseded: boolean;
  };
}

// ============================================================================
// Surprise Types (P2: Surprise-Based Learning)
// ============================================================================

/**
 * Surprise metrics for an observation
 * Inspired by Nested Learning: high surprise = increase learning rate
 *
 * When new information differs significantly from expectations,
 * it should be weighted more heavily in memory consolidation.
 */
export interface SurpriseMetrics {
  /**
   * Semantic novelty: how different is this from existing memories?
   * 0 = very similar to existing, 1 = completely novel
   */
  semanticNovelty: number;

  /**
   * Pattern deviation: how much does this deviate from common patterns?
   * 0 = follows typical patterns, 1 = highly unusual
   */
  patternDeviation: number;

  /**
   * Context mismatch: does this fit expected context for this project/type?
   * 0 = fits perfectly, 1 = completely unexpected context
   */
  contextMismatch: number;

  /**
   * Combined surprise score (weighted average)
   * High surprise = important to retain, resist supersession
   */
  surpriseScore: number;

  /**
   * When surprise was calculated
   */
  calculatedAt: number;
}

/**
 * Surprise tier for display and filtering
 */
export type SurpriseTier = 'routine' | 'notable' | 'surprising' | 'anomalous';

/**
 * Get surprise tier from score
 */
export function getSurpriseTier(score: number): SurpriseTier {
  if (score >= 0.8) return 'anomalous';
  if (score >= 0.6) return 'surprising';
  if (score >= 0.4) return 'notable';
  return 'routine';
}

/**
 * Configuration for surprise detection
 */
export interface SurpriseConfig {
  enabled: boolean;

  /**
   * Weights for combining surprise components
   */
  weights: {
    semanticNovelty: number;    // Default: 0.4
    patternDeviation: number;   // Default: 0.35
    contextMismatch: number;    // Default: 0.25
  };

  /**
   * Minimum surprise score to mark as "notable"
   */
  notableThreshold: number;     // Default: 0.4

  /**
   * Surprise score that protects from supersession
   * Observations above this won't be superseded even if semantically similar
   */
  protectionThreshold: number;  // Default: 0.7

  /**
   * Number of similar observations to compare against
   */
  comparisonPoolSize: number;   // Default: 20
}

/**
 * Default surprise configuration
 */
export const DEFAULT_SURPRISE_CONFIG: SurpriseConfig = {
  enabled: true,
  weights: {
    semanticNovelty: 0.4,
    patternDeviation: 0.35,
    contextMismatch: 0.25,
  },
  notableThreshold: 0.4,
  protectionThreshold: 0.7,
  comparisonPoolSize: 20,
};

// ============================================================================
// Supersession Types
// ============================================================================

/**
 * Feature set for supersession prediction (P3: Regression Model)
 * Inspired by Deep Optimizers from Nested Learning paper
 * Using learned weights instead of fixed coefficients
 */
export interface SupersessionFeatures {
  /**
   * Semantic similarity from vector search (0-1)
   */
  semanticSimilarity: number;

  /**
   * Whether topics/concepts match
   */
  topicMatch: boolean;

  /**
   * File overlap Jaccard index (0-1)
   */
  fileOverlap: number;

  /**
   * Type match score (1.0 if same type, 0.0 otherwise)
   */
  typeMatch: number;

  /**
   * Time difference in hours (newer - older)
   */
  timeDeltaHours: number;

  /**
   * Whether projects match (always true in current implementation)
   */
  projectMatch: boolean;

  /**
   * Priority score of newer observation (0-1)
   */
  priorityScore: number;

  /**
   * Whether older observation is superseded
   */
  isSuperseded: boolean;

  /**
   * Number of times older observation was referenced
   */
  olderReferenceCount: number;
}

/**
 * Training example for the regression model
 */
export interface SupersessionTrainingExample {
  features: SupersessionFeatures;
  /**
   * True if this supersession was accepted/applied
   * False if rejected or reverted by user
   */
  label: boolean;
  /**
   * Confidence score that was used
   */
  confidence: number;
  /**
   * Timestamp when this example was recorded
   */
  timestamp: number;
}

/**
 * Configuration for the learned supersession model
 */
export interface LearnedModelConfig {
  enabled: boolean;

  /**
   * Learning rate for online gradient descent
   */
  learningRate: number;

  /**
   * L2 regularization strength
   */
  regularization: number;

  /**
   * Minimum examples required before using learned weights
   */
  minExamplesBeforeUse: number;

  /**
   * Whether to use fixed weights as fallback
   */
  fallbackToFixed: boolean;

  /**
   * Maximum number of training examples to store
   */
  maxTrainingExamples: number;

  /**
   * Whether to collect training data even when disabled
   */
  alwaysCollectData: boolean;
}

/**
 * Default learned model configuration
 */
export const DEFAULT_LEARNED_MODEL_CONFIG: LearnedModelConfig = {
  enabled: false, // Disabled by default, requires training data
  learningRate: 0.01,
  regularization: 0.001,
  minExamplesBeforeUse: 50,
  fallbackToFixed: true,
  maxTrainingExamples: 1000,
  alwaysCollectData: true,
};

/**
 * Learned weights for supersession features
 * Corresponds to coefficients in the regression model
 */
export interface LearnedWeights {
  semanticSimilarity: number;
  topicMatch: number;
  fileOverlap: number;
  typeMatch: number;
  timeDecay: number; // Applied to timeDeltaHours
  priorityBoost: number; // Applied to priorityScore
  referenceDecay: number; // Applied to olderReferenceCount
  bias: number; // Intercept term
}

/**
 * Initial weights (matches current fixed weights)
 */
export const INITIAL_WEIGHTS: LearnedWeights = {
  semanticSimilarity: 0.4,
  topicMatch: 0.2,
  fileOverlap: 0.2,
  typeMatch: 0.2,
  timeDecay: 0.0,
  priorityBoost: 0.0,
  referenceDecay: 0.0,
  bias: 0.0,
};

/**
 * Model training result
 */
export interface ModelTrainingResult {
  examplesUsed: number;
  weights: LearnedWeights;
  loss: number; // Mean squared error
  accuracy: number; // Classification accuracy
  timestamp: number;
}

/**
 * Model prediction with metadata
 */
export interface SupersessionPrediction {
  confidence: number;
  usingLearnedWeights: boolean;
  weights: LearnedWeights;
  featureContributions: {
    semanticSimilarity: number;
    topicMatch: number;
    fileOverlap: number;
    typeMatch: number;
    timeDecay: number;
    priorityBoost: number;
    referenceDecay: number;
    bias: number;
  };
}

/**
 * Represents a detected supersession relationship
 */
export interface SupersessionCandidate {
  olderId: number;           // Observation being superseded
  newerId: number;           // Observation that supersedes
  confidence: number;        // 0-1, how confident in this relationship
  reason: string;            // Human-readable explanation
  semanticSimilarity: number; // 0-1, semantic embedding similarity
  topicMatch: boolean;       // Whether topics/concepts match
  fileOverlap: number;       // 0-1, overlap in files_modified
  // P1: Priority information
  olderType: string;         // Type of older observation
  newerType: string;         // Type of newer observation
  priority: number;          // 0-1, priority weight of the newer observation
  priorityTier: PriorityTier; // Priority tier for display
}

/**
 * Result of supersession detection
 */
export interface SupersessionResult {
  candidates: SupersessionCandidate[];
  processedCount: number;
  duration: number;
}

/**
 * Configuration for supersession detection
 */
export interface SupersessionConfig {
  minSemanticSimilarity: number;  // Default: 0.7
  minConfidence: number;          // Default: 0.6
  sameTypeRequired: boolean;      // Default: true
  sameProjectRequired: boolean;   // Default: true
  maxAgeDifferenceHours: number;  // Default: 720 (30 days)
}

// ============================================================================
// Decision Chain Types
// ============================================================================

/**
 * A chain of related decisions
 */
export interface DecisionChain {
  chainId: string;
  observations: number[];    // Ordered list of observation IDs
  rootTopic: string;         // Common topic/concept
  createdAt: number;
  updatedAt: number;
}

/**
 * Result of decision chain detection
 */
export interface ChainDetectionResult {
  chains: DecisionChain[];
  orphanedDecisions: number[];
  duration: number;
}

// ============================================================================
// Sleep Cycle Types
// ============================================================================

/**
 * Type of sleep cycle
 * - micro: Session-end immediate processing (P0 optimization)
 * - light: Short idle period processing
 * - deep: Extended idle period processing
 * - manual: User-triggered full processing
 */
export type SleepCycleType = 'micro' | 'light' | 'deep' | 'manual';

/**
 * Configuration for a sleep cycle
 */
export interface SleepCycleConfig {
  type: SleepCycleType;

  // Supersession detection
  supersessionEnabled: boolean;
  supersessionThreshold: number;    // Minimum confidence to mark (default: 0.7)
  supersessionLookbackDays: number; // How far back to look (default: 90)

  // Decision chain detection
  chainDetectionEnabled: boolean;
  chainSimilarityThreshold: number; // Min semantic similarity (default: 0.75)

  // Deprecation
  deprecationEnabled: boolean;
  deprecateAfterDays: number;       // Auto-deprecate superseded after N days

  // Processing limits
  maxObservationsPerCycle: number;  // Prevent long-running cycles
  batchSize: number;
  dryRun: boolean;

  // P1: Priority configuration
  priority: PriorityConfig;

  // P2: Memory Tier configuration
  memoryTier: MemoryTierConfig;
}

/**
 * Default configuration by cycle type
 */
export const SLEEP_CYCLE_DEFAULTS: Record<SleepCycleType, SleepCycleConfig> = {
  micro: {
    type: 'micro',
    supersessionEnabled: true,
    supersessionThreshold: 0.7,
    supersessionLookbackDays: 7,      // Only recent observations
    chainDetectionEnabled: false,
    chainSimilarityThreshold: 0.75,
    deprecationEnabled: false,
    deprecateAfterDays: 180,
    maxObservationsPerCycle: 50,      // Session typically has < 50 observations
    batchSize: 10,
    dryRun: false,
    priority: {
      enabled: true,
      confidenceBoostFactor: 0.1,    // Boost high-priority observations
      priorityOrdering: true,
    },
    memoryTier: {
      ...DEFAULT_MEMORY_TIER_CONFIG,
      reclassifyOnSleepCycle: false, // Don't reclassify on micro cycles (too frequent)
    },
  },
  light: {
    type: 'light',
    supersessionEnabled: true,
    supersessionThreshold: 0.8,
    supersessionLookbackDays: 30,
    chainDetectionEnabled: false,
    chainSimilarityThreshold: 0.75,
    deprecationEnabled: false,
    deprecateAfterDays: 180,
    maxObservationsPerCycle: 100,
    batchSize: 20,
    dryRun: false,
    priority: {
      enabled: true,
      confidenceBoostFactor: 0.05,   // Smaller boost for light cycles
      priorityOrdering: true,
    },
    memoryTier: {
      ...DEFAULT_MEMORY_TIER_CONFIG,
      reclassifyOnSleepCycle: true,
    },
  },
  deep: {
    type: 'deep',
    supersessionEnabled: true,
    supersessionThreshold: 0.7,
    supersessionLookbackDays: 90,
    chainDetectionEnabled: true,
    chainSimilarityThreshold: 0.7,
    deprecationEnabled: true,
    deprecateAfterDays: 180,
    maxObservationsPerCycle: 500,
    batchSize: 50,
    dryRun: false,
    priority: {
      enabled: true,
      confidenceBoostFactor: 0.1,
      priorityOrdering: true,
    },
    memoryTier: {
      ...DEFAULT_MEMORY_TIER_CONFIG,
      reclassifyOnSleepCycle: true,
    },
  },
  manual: {
    type: 'manual',
    supersessionEnabled: true,
    supersessionThreshold: 0.6,
    supersessionLookbackDays: 365,
    chainDetectionEnabled: true,
    chainSimilarityThreshold: 0.65,
    deprecationEnabled: true,
    deprecateAfterDays: 90,
    maxObservationsPerCycle: 1000,
    batchSize: 100,
    dryRun: false,
    priority: {
      enabled: true,
      confidenceBoostFactor: 0.15,   // Larger boost for manual cycles
      priorityOrdering: true,
    },
    memoryTier: {
      ...DEFAULT_MEMORY_TIER_CONFIG,
      reclassifyOnSleepCycle: true,
    },
  },
};

/**
 * Result of a complete sleep cycle
 */
export interface SleepCycleResult {
  cycleId: number;
  type: SleepCycleType;
  startedAt: number;
  completedAt: number;
  duration: number;

  supersession: SupersessionResult | null;
  chains: ChainDetectionResult | null;

  summary: {
    observationsProcessed: number;
    supersessionsDetected: number;
    chainsConsolidated: number;
    memoriesDeprecated: number;
    // P1: Priority stats
    byPriorityTier?: {
      critical: number;
      high: number;
      medium: number;
      low: number;
    };
    // P2: Memory Tier stats
    byMemoryTier?: {
      core: number;
      working: number;
      archive: number;
      ephemeral: number;
    };
    memoryTierUpdates?: number;
  };

  error?: string;
}

// ============================================================================
// Idle Detection Types
// ============================================================================

/**
 * Idle state for triggering sleep cycles
 */
export interface IdleState {
  isIdle: boolean;
  lastActivityAt: number;
  idleDurationMs: number;
  activeSessions: number;
}

/**
 * Configuration for idle detection
 */
export interface IdleConfig {
  lightSleepAfterMs: number;    // Trigger light sleep after N ms idle (default: 5 min)
  deepSleepAfterMs: number;     // Trigger deep sleep after N ms idle (default: 30 min)
  checkIntervalMs: number;      // How often to check idle state (default: 1 min)
  requireNoActiveSessions: boolean;
}

/**
 * Default idle configuration
 */
export const DEFAULT_IDLE_CONFIG: IdleConfig = {
  lightSleepAfterMs: 5 * 60 * 1000,      // 5 minutes
  deepSleepAfterMs: 30 * 60 * 1000,      // 30 minutes
  checkIntervalMs: 60 * 1000,            // 1 minute
  requireNoActiveSessions: true,
};

/**
 * Minimum intervals between sleep cycles (prevents thrashing)
 */
export const MIN_LIGHT_CYCLE_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
export const MIN_DEEP_CYCLE_INTERVAL_MS = 30 * 60 * 1000;   // 30 minutes

// ============================================================================
// Sleep Agent Status Types
// ============================================================================

/**
 * Current status of the Sleep Agent
 */
export interface SleepAgentStatus {
  isRunning: boolean;
  idleDetectionEnabled: boolean;
  idleState: IdleState;
  lastCycle: SleepCycleResult | null;
  stats: {
    totalCycles: number;
    totalSupersessions: number;
    totalDeprecated: number;
  };
}

/**
 * Sleep cycle database row
 */
export interface SleepCycleRow {
  id: number;
  started_at_epoch: number;
  completed_at_epoch: number | null;
  cycle_type: SleepCycleType;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  observations_processed: number;
  supersessions_detected: number;
  chains_consolidated: number;
  memories_deprecated: number;
  error_message: string | null;
}
