# Titans Concepts Integration Plan for claude-mem

## Overview

This document outlines the plan to integrate key concepts from the [Titans + MIRAS](https://research.google/blog/titans-miras-helping-ai-have-long-term-memory/) research into claude-mem.

**Important Note**: claude-mem is an external memory system, while Titans implements internal neural memory. We can borrow the philosophical concepts but not achieve identical effects without training neural networks.

### Key Concepts from Titans

| Concept | Description | Our Implementation Approach |
|---------|-------------|---------------------------|
| **Surprise Metric** | Detect unexpected information to prioritize storage | Semantic distance-based novelty scoring |
| **Momentum** | Boost related topics after high-surprise events | Short-term topic boost buffer |
| **Forgetting** | Adaptive decay of unused information | Importance-based retention policy |
| **Deep Memory** | MLP-based memory with high expressive power | Concept network (Phase 4) |

---

## Phases Overview

```
Phase 1: Infrastructure  ───►  Phase 2: Surprise System  ───►  Phase 3: Smart Management  ───►  Phase 4: Advanced
   (Tracking & Scoring)         (Filtering & Boosting)        (Forgetting & Compression)      (Concept Network)
```

---

## Phase 1: Infrastructure

**Goal**: Build tracking and scoring foundation

| Task | Description | File | Priority |
|------|-------------|------|----------|
| 1.1 Memory Access Tracking | Track retrieval frequency and timing | `src/services/worker/AccessTracker.ts` | High |
| 1.2 Importance Scoring | Calculate initial importance scores | `src/services/worker/ImportanceScorer.ts` | High |
| 1.3 Semantic Rarity | Compute semantic space rarity | `src/services/worker/SemanticRarity.ts` | Medium |
| 1.4 Database Schema | Add access tracking fields | `src/services/sqlite/schema.sql` | High |
| 1.5 Worker API Endpoints | Memory statistics APIs | `src/services/worker/routes.ts` | Medium |

### 1.1 Memory Access Tracker

```typescript
// src/services/worker/AccessTracker.ts
interface MemoryAccess {
  memoryId: string;
  timestamp: number;
  context?: string;
}

class AccessTracker {
  async recordAccess(memoryId: string, context?: string): Promise<void>;
  async getAccessHistory(memoryId: string): Promise<MemoryAccess[]>;
  async getAccessFrequency(memoryId: string, days: number = 30): Promise<number>;
}
```

### 1.2 Importance Scorer

```typescript
// src/services/worker/ImportanceScorer.ts
interface ImportanceFactors {
  initialScore: number;
  typeBonus: number;
  semanticRarity: number;
  surprise: number;
  accessFrequency: number;
  age: number;
}

class ImportanceScorer {
  async score(observation: Observation): Promise<number>;
  async updateScore(memoryId: string): Promise<number>;
}
```

### 1.4 Database Schema

```sql
CREATE TABLE memory_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  context TEXT,
  FOREIGN KEY (memory_id) REFERENCES observations(id)
);

ALTER TABLE observations ADD COLUMN importance_score REAL DEFAULT 0.5;
ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE observations ADD COLUMN last_accessed INTEGER;
```

---

## Phase 2: Surprise System

**Goal**: Implement surprise filtering and momentum weighting

| Task | Description | File | Priority |
|------|-------------|------|----------|
| 2.1 Surprise Metric | Compute semantic distance to existing memories | `src/services/worker/SurpriseMetric.ts` | High |
| 2.2 Momentum Buffer | Short-term boost for related topics | `src/services/worker/MomentumBuffer.ts` | Medium |
| 2.3 Threshold Config | Configurable surprise thresholds | `src/shared/config.ts` | Medium |
| 2.4 Hook Integration | Apply filtering in PostToolUse | `src/hooks/save-hook.ts` | High |
| 2.5 Visualization | Show surprise scores in viewer | `src/ui/viewer/` | Low |

### 2.1 Surprise Metric

```typescript
// src/services/worker/SurpriseMetric.ts
interface SurpriseResult {
  score: number;
  confidence: number;
  similarMemories: string[];
}

class SurpriseMetric {
  async compute(
    observation: Observation,
    recentMemories: Memory[]
  ): Promise<SurpriseResult>;
}
```

### 2.2 Momentum Buffer

```typescript
// src/services/worker/MomentumBuffer.ts
interface BoostedTopic {
  topic: string;
  expiry: number;
  boostFactor: number;
}

class MomentumBuffer {
  async boost(topic: string, duration: number = 5): Promise<void>;
  isBoosted(topic: string): boolean;
  async cleanup(): Promise<void>;
}
```

---

## Phase 3: Smart Management

**Goal**: Adaptive forgetting and intelligent compression

| Task | Description | File | Priority |
|------|-------------|------|----------|
| 3.1 Forgetting Policy | Retention decisions based on importance | `src/services/worker/ForgettingPolicy.ts` | High |
| 3.2 Cleanup Job | Automatic low-value memory cleanup | `src/services/worker/CleanupJob.ts` | Medium |
| 3.3 Compression Optimization | Adjust compression based on importance | `src/services/worker/CompressionOptimizer.ts` | Medium |
| 3.4 User Settings | Forgetting policy configuration UI | `src/ui/viewer/settings/` | Low |

### 3.1 Forgetting Policy

```typescript
// src/services/worker/ForgettingPolicy.ts
interface RetentionDecision {
  shouldRetain: boolean;
  reason?: string;
  newScore?: number;
}

class ForgettingPolicy {
  async evaluate(memory: Memory): Promise<RetentionDecision>;
}
```

---

## Phase 4: Advanced Features

**Goal**: Concept network and smarter organization

| Task | Description | File | Priority |
|------|-------------|------|----------|
| 4.1 Concept Extraction | Extract key concepts from observations | `src/services/worker/ConceptExtractor.ts` | Low |
| 4.2 Concept Network | Build concept association graph | `src/services/worker/ConceptNetwork.ts` | Low |
| 4.3 Semantic Retrieval | Concept network-based retrieval | `src/services/worker/SemanticRetrieval.ts` | Low |
| 4.4 Visualization | Concept graph visualization | `src/ui/viewer/concept-graph.tsx` | Low |

### 4.2 Concept Network

```typescript
// src/services/worker/ConceptNetwork.ts
interface ConceptNode {
  id: string;
  label: string;
  embeddings: number[];
  related: ConceptRelation[];
  examples: string[];
  importance: number;
}

interface ConceptRelation {
  targetId: string;
  weight: number;
  type: 'causes' | 'solves' | 'related' | 'contains';
}

class ConceptNetwork {
  async integrate(observation: Observation): Promise<void>;
  async findRelated(concept: string, depth: number = 2): Promise<ConceptNode[]>;
  async getPath(from: string, to: string): Promise<ConceptNode[]>;
}
```

---

## Development Timeline

```
Week 1                    Weeks 2-3                  Weeks 4-5                  Week 6+
│                          │                          │                          │
▼                          ▼                          ▼                          ▼
┌────────────┐         ┌────────────┐            ┌────────────┐            ┌────────────┐
│ Phase 1    │         │ Phase 2    │            │ Phase 3    │            │ Phase 4    │
│ (Infrastructure) │   │ (Surprise System)  │    │ (Smart Management) │   │ (Advanced)  │
│            │         │            │            │            │            │            │
│ - Access tracking     │ - Surprise calculation   │ - Forgetting policy      │ - Concept network
│ - Scoring system      │ - Momentum buffer        │ - Cleanup job            │
│ - DB update           │ - Hook integration       │                          │
└────────────┘         └────────────┘            └────────────┘            └────────────┘
```

---

## Testing Plan

| Phase | Testing Focus |
|-------|--------------|
| Phase 1 | Access tracking accuracy, scoring correctness |
| Phase 2 | Surprise filtering effectiveness, performance |
| Phase 3 | Forgetting policy rationality, memory quality |
| Phase 4 | Concept extraction accuracy, retrieval quality |
