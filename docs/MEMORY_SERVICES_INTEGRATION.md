# Claude-mem Memory Services Integration Guide

This guide explains how to integrate the new P0-P2 memory services into claude-mem, inspired by MemOS architecture.

## Overview

Three new services have been implemented:

| Priority | Service | File | Purpose |
|----------|---------|------|---------|
| **P0** | MemoryFeedbackService | `memory/MemoryFeedbackService.ts` | Natural language memory correction |
| **P1** | WorkingMemoryService | `memory/WorkingMemoryService.ts` | Two-tier memory cache |
| **P2** | MemoryCubeService | `memory/MemoryCubeService.ts` | Multi-project memory isolation |

---

## P0: Memory Feedback Service

### Purpose

Allow users to correct/modify memories using natural language feedback. Inspired by MemOS's `MemFeedback` class.

### Features

- **Automatic feedback detection**: Detects patterns like "X is actually Y", "Remember: X should be Y"
- **Keyword replacement**: Simple deterministic replacement of terms
- **Semantic feedback**: Stores user feedback for future reference
- **Confidence scoring**: Only processes feedback above confidence threshold

### Integration Points

#### 1. In SessionEnd Hook

```typescript
// src/hooks/session-end-hook.ts
import { MemoryFeedbackService } from '../services/memory/index.js';

// Check if user provided feedback before session ends
const userInput = getLastUserPrompt();
const feedbackResult = await memoryFeedbackService.processFeedback(
  userInput,
  memorySessionId,
  project
);
```

#### 2. In UserPromptSubmit Hook

```typescript
// src/hooks/user-prompt-submit-hook.ts
// Pre-check if user is providing feedback
const detection = memoryFeedbackService.detectFeedback(userPrompt);
if (detection.isFeedback) {
  logger.info('HOOK', 'User feedback detected', { confidence: detection.confidence });
}
```

### Usage Example

```typescript
import { MemoryFeedbackService } from './services/memory/index.js';

const feedbackService = new MemoryFeedbackService(
  searchManager,
  storeObservation
);

// User says: "Actually, the API endpoint is /api/v2/users"
await feedbackService.processFeedback(
  "Actually, the API endpoint is /api/v2/users",
  memorySessionId,
  "my-project"
);

// Result: Creates a correction observation that can be referenced later
```

### Configuration

```typescript
feedbackService.updateConfig({
  enabled: true,
  autoDetect: true,
  confidenceThreshold: 0.7
});
```

---

## P1: Working Memory Service

### Purpose

Two-tier memory system for faster retrieval. Inspired by MemOS's `TreeTextMemory` with working/long-term separation.

### Features

- **LRU eviction**: Automatically removes least recently used items
- **Fast in-memory search**: Before querying database
- **Seamless fallback**: Falls back to long-term memory if not found
- **Periodic compression**: Compresses working memory to long-term

### Integration Points

#### 1. In Context Generator

```typescript
// src/services/context-generator.ts
import { WorkingMemoryService } from './memory/index.js';

const workingMemory = new WorkingMemoryService({ maxSize: 20 });

// Before database search
const workingResults = workingMemory.searchWorkingMemory(query, {
  limit: 10,
  type: 'decision'
});

if (workingResults.length > 0) {
  return workingResults;
}
// Fall back to database search
```

#### 2. After Observation Retrieval

```typescript
// Add retrieved observations to working memory
for (const obs of retrievedObservations) {
  workingMemory.addToWorkingMemory(obs);
}
```

#### 3. Periodic Compression

```typescript
// Run periodically (e.g., every 5 minutes)
if (workingMemory.needsCompression()) {
  const toCompress = workingMemory.getItemsToCompress();
  // These are already in long-term storage, just being evicted from cache
  logger.info('WORKING_MEMORY', 'Compressed working memory', {
    count: toCompress.length
  });
}
```

### Usage Example

```typescript
import { WorkingMemoryService } from './services/memory/index.js';

const workingMemory = new WorkingMemoryService({
  maxSize: 20,           // Max items in working memory
  compressionThreshold: 15,
  compressionInterval: 5 * 60 * 1000
});

// Search working memory first
const results = workingMemory.searchWorkingMemory('database schema', {
  limit: 5,
  type: 'decision'
});

// Add item to working memory
workingMemory.addToWorkingMemory(observationResult);

// Get statistics
const stats = workingMemory.getStats();
console.log(`Working memory: ${stats.size}/${stats.capacity}`);
```

### Configuration

```typescript
workingMemory.updateConfig({
  maxSize: 30,
  compressionThreshold: 20,
  compressionInterval: 10 * 60 * 1000 // 10 minutes
});
```

---

## P2: Memory Cube Service

### Purpose

Multi-project memory isolation. Inspired by MemOS's `MemCube` concept.

### Features

- **Project-based isolation**: Different projects use different cubes
- **Export/import**: Share memory cubes as JSON
- **Cube merging**: Combine multiple cubes
- **Auto-creation**: Creates project cubes on demand

### Integration Points

#### 1. In Observation Storage

```typescript
// src/services/sqlite/observations/store.ts
import { MemoryCubeService } from '../memory/index.js';

const memoryCubeService = new MemoryCubeService();

// After storing observation
memoryCubeService.addToCube(storedObservation);
```

#### 2. In Search Manager

```typescript
// src/services/worker/SearchManager.ts
// Search within specific project cube
const cubeResults = memoryCubeService.searchCube(
  'project-my-app',
  query,
  { limit: 20, type: 'decision' }
);
```

#### 3. Cube Management API

```typescript
// New API endpoints for cube management
app.get('/api/cubes', (req, res) => {
  const cubes = memoryCubeService.listCubes();
  res.json(cubes);
});

app.post('/api/cubes/:cubeId/export', (req, res) => {
  const path = memoryCubeService.exportCube(req.params.cubeId);
  res.json({ path });
});
```

### Usage Example

```typescript
import { MemoryCubeService } from './services/memory/index.js';

const memoryCubeService = new MemoryCubeService('./data/cubes');

// Create a new cube for a project
memoryCubeService.createCube('project-my-app', 'My App Project', {
  projectFilter: 'my-app',
  description: 'Memory for the my-app project'
});

// Set as active cube
memoryCubeService.setActiveCube('project-my-app');

// Export cube to share with team
const exportPath = memoryCubeService.exportCube('project-my-app');

// Import cube from team member
memoryCubeService.importCube('./team-cubes/shared-knowledge.json', 'shared-team');

// Merge cubes
memoryCubeService.mergeCube('shared-team', 'project-my-app', {
  strategy: 'merge',
  conflictResolution: 'keep-new'
});
```

---

## Integration Checklist

### Phase 1: Basic Integration (P0)

- [ ] Add `MemoryFeedbackService` to worker service initialization
- [ ] Wire up feedback processing in `session-end-hook.ts`
- [ ] Add configuration options to settings.json
- [ ] Test feedback detection with various user inputs
- [ ] Add logging and metrics

### Phase 2: Performance Enhancement (P1)

- [ ] Initialize `WorkingMemoryService` in worker service
- [ ] Update context generator to check working memory first
- [ ] Add working memory population after observation retrieval
- [ ] Implement periodic compression task
- [ ] Add stats endpoint for monitoring

### Phase 3: Multi-Project Support (P2)

- [ ] Initialize `MemoryCubeService` with storage path
- [ ] Add cube routing in observation storage
- [ ] Add cube filtering in search
- [ ] Implement cube management API endpoints
- [ ] Add cube export/import UI in viewer

---

## API Reference

### MemoryFeedbackService

```typescript
class MemoryFeedbackService {
  // Main entry point - process user feedback
  async processFeedback(
    feedback: string,
    memorySessionId: string,
    project: string
  ): Promise<FeedbackResult>

  // Check if input contains feedback patterns
  detectFeedback(userInput: string): { isFeedback: boolean; confidence: number }

  // Extract X -> Y correction pattern
  extractCorrection(feedback: string): { original: string; corrected: string } | null

  // Configuration
  setEnabled(enabled: boolean): void
  updateConfig(config: Partial<FeedbackConfig>): void
  getConfig(): FeedbackConfig
}
```

### WorkingMemoryService

```typescript
class WorkingMemoryService {
  // Add item to working memory (implements LRU eviction)
  addToWorkingMemory(item: ObservationSearchResult): void

  // Get specific item by ID
  getFromWorkingMemory(id: number): ObservationSearchResult | null

  // Search working memory
  searchWorkingMemory(query: string, options?: SearchOptions): ObservationSearchResult[]

  // Check if compression is needed
  needsCompression(): boolean

  // Get items to compress (LRU items above threshold)
  getItemsToCompress(): ObservationSearchResult[]

  // Statistics
  getStats(): { size: number; capacity: number; utilization: number; topAccessed: Array<...> }

  // Configuration
  updateConfig(config: Partial<WorkingMemoryConfig>): void
}
```

### MemoryCubeService

```typescript
class MemoryCubeService {
  // Create a new cube
  createCube(cubeId: string, name: string, config?: Partial<MemoryCubeConfig>): MemoryCube

  // Get or create project-specific cube
  getOrCreateProjectCube(project: string): MemoryCube

  // Add observation to appropriate cube
  addToCube(observation: ObservationSearchResult): void

  // Search within a cube
  searchCube(cubeId: string, query?: string, options?: {...}): ObservationSearchResult[]

  // Export/import
  exportCube(cubeId: string, exportPath?: string): string
  importCube(importPath: string, cubeId?: string): MemoryCube

  // Merge cubes
  mergeCube(sourceCubeId: string, targetCubeId: string, options?: CubeMergeOptions): void

  // Cube management
  setActiveCube(cubeId: string): void
  getActiveCube(): MemoryCube | null
  listCubes(): Array<{...}>
  deleteCube(cubeId: string): boolean
  getCubeStats(cubeId: string): {...} | null
}
```

---

## Testing

### Unit Tests

```typescript
// Test MemoryFeedbackService
describe('MemoryFeedbackService', () => {
  it('should detect feedback patterns', () => {
    const service = new MemoryFeedbackService(searchManager, storeObs);
    expect(service.detectFeedback('X is actually Y').isFeedback).toBe(true);
  });

  it('should extract corrections', () => {
    const service = new MemoryFeedbackService(searchManager, storeObs);
    const correction = service.extractCorrection('API is actually /v2/users');
    expect(correction).toEqual({ original: 'API', corrected: '/v2/users' });
  });
});

// Test WorkingMemoryService
describe('WorkingMemoryService', () => {
  it('should evict LRU items when capacity exceeded', () => {
    const service = new WorkingMemoryService({ maxSize: 3 });
    // Add 4 items, first should be evicted
    service.addToWorkingMemory(obs1);
    service.addToWorkingMemory(obs2);
    service.addToWorkingMemory(obs3);
    service.addToWorkingMemory(obs4);
    expect(service.getFromWorkingMemory(obs1.id)).toBeNull();
  });
});

// Test MemoryCubeService
describe('MemoryCubeService', () => {
  it('should create and export cubes', () => {
    const service = new MemoryCubeService('/tmp/test-cubes');
    service.createCube('test', 'Test Cube');
    service.addToCube(observation);
    const path = service.exportCube('test');
    expect(existsSync(path)).toBe(true);
  });
});
```

### Integration Tests

```typescript
// Test full workflow
describe('Memory Services Integration', () => {
  it('should process feedback and add to working memory', async () => {
    const feedbackService = new MemoryFeedbackService(...);
    const workingMemory = new WorkingMemoryService();

    // Process user feedback
    const result = await feedbackService.processFeedback(
      'The API is /v2/users',
      sessionId,
      project
    );

    // Result should be in working memory
    const retrieved = workingMemory.searchWorkingMemory('API');
    expect(retrieved.length).toBeGreaterThan(0);
  });
});
```

---

## Migration Path

### Step 1: Add Services (No Breaking Changes)

Initialize services but don't integrate into existing flows. Add behind feature flags.

### Step 2: Gradual Integration

- Add feedback processing to session-end hook
- Add working memory check before database search
- Add cube routing to new observations only

### Step 3: Full Integration

- Make working memory mandatory for all searches
- Enable automatic cube management
- Add UI for cube management

---

## Performance Impact

| Service | Memory | CPU | Latency Impact |
|---------|--------|-----|----------------|
| MemoryFeedback | +~1MB per 100 feedbacks | +~50ms per feedback | None (async) |
| WorkingMemory | +~500KB for 20 items | +~10ms per search | -~50ms (cache hit) |
| MemoryCube | +~100KB per cube | +~5ms per obs | None (background) |

---

## Future Enhancements

Based on MemOS analysis, consider adding:

1. **Reranker**: Re-score search results using local embedding model
2. **Memory Monitor**: Track memory access frequency and importance
3. **Task Scheduler**: Priority queue for async memory operations
4. **Multi-modal Memory**: Support for image/document memories
5. **Memory Graph**: Neo4j-style relationship tracking

---

## Questions?

See the MemOS comparison document or check the source files:
- `src/services/memory/MemoryFeedbackService.ts`
- `src/services/memory/WorkingMemoryService.ts`
- `src/services/memory/MemoryCubeService.ts`
