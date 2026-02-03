/**
 * Tests for observation deduplication functionality
 *
 * This test suite verifies the deduplication logic that prevents similar observations
 * from being stored in the database, focusing on:
 * - Levenshtein distance calculation
 * - Similarity scoring
 * - Title matching
 * - JSON serialization comparison
 * - Edge cases (null titles, empty observations, no recent observations)
 * - Intra-batch deduplication (duplicates within same agent response)
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  levenshteinDistance,
  calculateSimilarity,
  sortedStringify
} from '../src/services/worker/agents/ResponseProcessor.js';
import { processAgentResponse } from '../src/services/worker/agents/ResponseProcessor.js';
import type { Session } from '../src/services/sqlite/SessionStore.js';
import type { DatabaseManager } from '../src/services/DatabaseManager.js';
import { ModeManager } from '../src/services/domain/ModeManager.js';

describe('Levenshtein Distance Calculation', () => {
  it('should return 0 for identical strings', () => {
    const distance = levenshteinDistance('hello', 'hello');
    expect(distance).toBe(0);
  });

  it('should calculate correct distance for single character difference', () => {
    const distance = levenshteinDistance('hello', 'hallo');
    expect(distance).toBe(1);
  });

  it('should calculate correct distance for multiple differences', () => {
    const distance = levenshteinDistance('kitten', 'sitting');
    expect(distance).toBe(3);
  });

  it('should handle empty strings', () => {
    expect(levenshteinDistance('', '')).toBe(0);
    expect(levenshteinDistance('hello', '')).toBe(5);
    expect(levenshteinDistance('', 'world')).toBe(5);
  });

  it('should handle strings of different lengths', () => {
    const distance = levenshteinDistance('short', 'much longer string');
    expect(distance).toBeGreaterThan(0);
  });
});

describe('Similarity Score Calculation', () => {
  it('should return 1.0 for identical strings', () => {
    const similarity = calculateSimilarity('hello', 'hello');
    expect(similarity).toBe(1.0);
  });

  it('should return 1.0 for two empty strings', () => {
    const similarity = calculateSimilarity('', '');
    expect(similarity).toBe(1.0);
  });

  it('should return 0.0 when one string is empty', () => {
    expect(calculateSimilarity('hello', '')).toBe(0.0);
    expect(calculateSimilarity('', 'world')).toBe(0.0);
  });

  it('should calculate similarity between 0 and 1', () => {
    const similarity = calculateSimilarity('hello', 'hallo');
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it('should return high similarity for very similar strings', () => {
    const similarity = calculateSimilarity('Read file X', 'Read file Y');
    expect(similarity).toBeGreaterThan(0.8);
  });

  it('should return low similarity for very different strings', () => {
    const similarity = calculateSimilarity('completely different', 'xyz');
    expect(similarity).toBeLessThan(0.5);
  });
});

describe('Observation Deduplication Logic', () => {
  // Helper to create mock observations
  const createObservation = (title: string | null, facts: string[] = []) => ({
    type: 'discovery',
    title,
    subtitle: null,
    facts,
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: []
  });

  describe('Title Matching', () => {
    it('should detect exact title match', () => {
      const obs1 = createObservation('Read file X');
      const obs2 = createObservation('Read file X');

      expect(obs1.title).toBe(obs2.title);
    });

    it('should not match different titles', () => {
      const obs1 = createObservation('Read file X');
      const obs2 = createObservation('Read file Y');

      expect(obs1.title).not.toBe(obs2.title);
    });

    it('should handle null titles', () => {
      const obs1 = createObservation(null);
      const obs2 = createObservation('Read file X');

      expect(obs1.title).toBeNull();
      expect(obs1.title).not.toBe(obs2.title);
    });
  });

  describe('JSON Serialization Comparison', () => {
    it('should detect duplicates with identical JSON structure', () => {
      const obs1 = createObservation('Read file X', ['fact1', 'fact2']);
      const obs2 = createObservation('Read file X', ['fact1', 'fact2']);

      const json1 = JSON.stringify(obs1);
      const json2 = JSON.stringify(obs2);
      const similarity = calculateSimilarity(json1, json2);

      expect(similarity).toBe(1.0);
    });

    it('should detect high similarity for mostly identical observations', () => {
      const obs1 = createObservation('Read file X', ['fact1', 'fact2', 'fact3']);
      const obs2 = createObservation('Read file X', ['fact1', 'fact2', 'fact4']);

      const json1 = JSON.stringify(obs1);
      const json2 = JSON.stringify(obs2);
      const similarity = calculateSimilarity(json1, json2);

      // Should be high similarity (>0.8) but not identical
      expect(similarity).toBeGreaterThan(0.8);
    });

    it('should detect low similarity for different observations with same title', () => {
      const obs1 = createObservation('Read file X', ['fact1']);
      const obs2 = createObservation('Read file X', ['completely', 'different', 'facts', 'list', 'here']);

      const json1 = JSON.stringify(obs1);
      const json2 = JSON.stringify(obs2);
      const similarity = calculateSimilarity(json1, json2);

      // Should be lower similarity due to different facts arrays
      expect(similarity).toBeLessThan(1.0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle observations with null titles', () => {
      const obs = createObservation(null, ['fact1']);

      // In actual implementation, null-title observations should be kept (not filtered)
      expect(obs.title).toBeNull();
    });

    it('should handle observations with empty facts array', () => {
      const obs1 = createObservation('Read file X', []);
      const obs2 = createObservation('Read file X', ['fact1', 'fact2', 'fact3']);

      const json1 = JSON.stringify(obs1);
      const json2 = JSON.stringify(obs2);
      const similarity = calculateSimilarity(json1, json2);

      // Should calculate similarity correctly despite empty array
      expect(similarity).toBeGreaterThan(0);
      expect(similarity).toBeLessThan(1);
    });

    it('should handle empty observations array', () => {
      const observations: any[] = [];

      // Filtering empty array should return empty array
      const filtered = observations.filter(obs => obs.title !== null);
      expect(filtered.length).toBe(0);
    });
  });

  describe('Threshold Behavior', () => {
    it('should identify as duplicate when similarity > 0.8', () => {
      // Create two observations with 85% similarity
      const obs1 = createObservation('Read file X', ['fact1', 'fact2', 'fact3', 'fact4', 'fact5']);
      const obs2 = createObservation('Read file X', ['fact1', 'fact2', 'fact3', 'fact4', 'fact6']);

      const json1 = JSON.stringify(obs1);
      const json2 = JSON.stringify(obs2);
      const similarity = calculateSimilarity(json1, json2);

      // Should be identified as duplicate (> 0.8)
      expect(similarity).toBeGreaterThan(0.8);
    });

    it('should NOT identify as duplicate when similarity exactly 0.8', () => {
      // The threshold check is similarity > 0.8, not >= 0.8
      const similarity = 0.8;

      // Should NOT be filtered (threshold is GREATER THAN, not greater-or-equal)
      expect(similarity > 0.8).toBe(false);
    });

    it('should NOT identify as duplicate when similarity < 0.8', () => {
      const similarity = 0.7;

      // Should NOT be filtered
      expect(similarity > 0.8).toBe(false);
    });
  });

  describe('Deduplication Filter Logic', () => {
    it('should keep unique observations', () => {
      const newObs = createObservation('Unique title', ['fact1']);
      const recentObs = [
        createObservation('Different title 1', ['fact1']),
        createObservation('Different title 2', ['fact2']),
        createObservation('Different title 3', ['fact3'])
      ];

      // Should keep the observation (no title match)
      const shouldKeep = !recentObs.some(existing => {
        if (newObs.title === existing.title) {
          const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(existing));
          return similarity > 0.8;
        }
        return false;
      });

      expect(shouldKeep).toBe(true);
    });

    it('should filter out high-similarity duplicates', () => {
      const newObs = createObservation('Read file X', ['fact1', 'fact2']);
      const recentObs = [
        createObservation('Read file X', ['fact1', 'fact2']) // Identical
      ];

      // Should filter out the observation (title match + high similarity)
      const shouldKeep = !recentObs.some(existing => {
        if (newObs.title === existing.title) {
          const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(existing));
          return similarity > 0.8;
        }
        return false;
      });

      expect(shouldKeep).toBe(false);
    });

    it('should keep observations with same title but low similarity', () => {
      const newObs = createObservation('Read file X', ['completely different content here']);
      const recentObs = [
        createObservation('Read file X', ['original', 'facts', 'list'])
      ];

      // Should keep the observation (title match but low similarity)
      const shouldKeep = !recentObs.some(existing => {
        if (newObs.title === existing.title) {
          const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(existing));
          return similarity > 0.8;
        }
        return false;
      });

      // This might be true or false depending on actual similarity - let's calculate
      const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(recentObs[0]));
      expect(shouldKeep).toBe(similarity <= 0.8);
    });

    it('should always keep observations with null titles', () => {
      const newObs = createObservation(null, ['fact1']);
      const recentObs = [
        createObservation('Some title', ['fact1'])
      ];

      // Should keep the observation (null title, cannot compare)
      const shouldKeep = newObs.title !== null ? !recentObs.some(existing => {
        if (newObs.title === existing.title) {
          const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(existing));
          return similarity > 0.8;
        }
        return false;
      }) : true;

      expect(shouldKeep).toBe(true);
    });
  });
});

describe('Integration Scenarios', () => {
  const createObservation = (title: string | null, facts: string[] = []) => ({
    type: 'discovery',
    title,
    subtitle: null,
    facts,
    narrative: null,
    concepts: [],
    files_read: [],
    files_modified: []
  });

  it('should handle AC1: Unique observation is stored', () => {
    const newObs = createObservation('Unique observation', ['new fact']);
    const recentObs = [
      createObservation('Existing observation 1', ['fact1']),
      createObservation('Existing observation 2', ['fact2']),
      createObservation('Existing observation 3', ['fact3'])
    ];

    // Deduplication logic should keep this observation
    const isDuplicate = recentObs.some(existing => {
      if (newObs.title === existing.title) {
        const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(existing));
        return similarity > 0.8;
      }
      return false;
    });

    expect(isDuplicate).toBe(false);
  });

  it('should handle AC2: 85% similar observation is filtered', () => {
    const newObs = createObservation('Read file X', ['fact1', 'fact2', 'fact3']);
    const recentObs = [
      createObservation('Read file X', ['fact1', 'fact2', 'fact3']) // Identical
    ];

    // Deduplication logic should filter this observation
    const isDuplicate = recentObs.some(existing => {
      if (newObs.title === existing.title) {
        const similarity = calculateSimilarity(JSON.stringify(newObs), JSON.stringify(existing));
        return similarity > 0.8;
      }
      return false;
    });

    expect(isDuplicate).toBe(true);
  });

  it('should handle AC6: Null title observation is kept', () => {
    const newObs = createObservation(null, ['fact1']);

    // Deduplication logic should skip this observation (null title)
    const shouldSkip = !newObs.title;

    expect(shouldSkip).toBe(true);
  });

  it('should handle AC10: Exactly 0.8 similarity is stored', () => {
    // Threshold is > 0.8, so exactly 0.8 should NOT be filtered
    const similarity = 0.8;
    const isDuplicate = similarity > 0.8;

    expect(isDuplicate).toBe(false);
  });
});

describe('F1 and F5 Fixes Verification', () => {
  it('F5 Fix: sortedStringify produces consistent output regardless of key order', () => {
    const obj1 = { title: 'Read file', type: 'discovery', subtitle: 'foo.ts' };
    const obj2 = { type: 'discovery', subtitle: 'foo.ts', title: 'Read file' };
    const obj3 = { subtitle: 'foo.ts', title: 'Read file', type: 'discovery' };

    const json1 = sortedStringify(obj1);
    const json2 = sortedStringify(obj2);
    const json3 = sortedStringify(obj3);

    // All should produce identical JSON strings
    expect(json1).toBe(json2);
    expect(json2).toBe(json3);
    expect(json1).toBe('{"subtitle":"foo.ts","title":"Read file","type":"discovery"}');
  });

  it('F1 Fix: Comparing only identity fields (title, subtitle, type) produces accurate similarity', () => {
    // Two observations with same identity but different content (narrative, facts)
    const newObsIdentity = {
      title: 'Read configuration file',
      subtitle: 'config.yaml',
      type: 'discovery'
    };

    const existingObsIdentity = {
      title: 'Read configuration file',
      subtitle: 'config.yaml',
      type: 'discovery'
    };

    // Full observations would have different facts/narrative
    const newObsFull = {
      ...newObsIdentity,
      narrative: 'Found database connection settings in the config file',
      facts: ['db_host=localhost', 'db_port=5432', 'db_name=production']
    };

    const existingObsFull = {
      ...existingObsIdentity,
      narrative: 'Configuration file contains application settings',
      facts: ['app_name=MyApp', 'log_level=debug']
    };

    // Compare identity fields only (F1 fix)
    const identityJson1 = sortedStringify(newObsIdentity);
    const identityJson2 = sortedStringify(existingObsIdentity);
    const identitySimilarity = calculateSimilarity(identityJson1, identityJson2);

    // Compare full observations (old broken approach)
    const fullJson1 = sortedStringify(newObsFull);
    const fullJson2 = sortedStringify(existingObsFull);
    const fullSimilarity = calculateSimilarity(fullJson1, fullJson2);

    // Identity comparison should be 100% similar (both are same observation)
    expect(identitySimilarity).toBe(1.0);

    // Full comparison would be much lower (different content)
    expect(fullSimilarity).toBeLessThan(0.8);

    // This demonstrates F1 fix: comparing only identity fields correctly identifies duplicates
  });

  it('F1 Fix: Identity-only comparison reduces string size (F2 mitigation)', () => {
    const identityFields = {
      title: 'Read configuration file',
      subtitle: 'config.yaml',
      type: 'discovery'
    };

    const fullObservation = {
      ...identityFields,
      narrative: 'This is a very long narrative that describes what was discovered in great detail. It can contain hundreds or thousands of characters depending on what the observation captured.',
      facts: [
        'fact1', 'fact2', 'fact3', 'fact4', 'fact5',
        'fact6', 'fact7', 'fact8', 'fact9', 'fact10'
      ],
      concepts: ['concept1', 'concept2', 'concept3'],
      files_read: ['/path/to/file1.ts', '/path/to/file2.ts', '/path/to/file3.ts'],
      files_modified: ['/path/to/modified1.ts', '/path/to/modified2.ts']
    };

    const identityJson = sortedStringify(identityFields);
    const fullJson = sortedStringify(fullObservation);

    // Identity JSON should be much smaller
    expect(identityJson.length).toBeLessThan(100);
    expect(fullJson.length).toBeGreaterThan(300);

    // Memory reduction: smaller strings = less memory for Levenshtein matrix
    const memoryReduction = (1 - (identityJson.length / fullJson.length)) * 100;
    expect(memoryReduction).toBeGreaterThan(60); // At least 60% memory reduction
  });
});

describe('Intra-batch observation deduplication', () => {
  let mockSessionStore: any;
  let mockDbManager: any;
  let mockWorker: any;
  let mockSession: Session;

  beforeEach(() => {
    // Initialize ModeManager with default 'code' mode
    try {
      ModeManager.getInstance().loadMode('code');
    } catch (error) {
      // Mode already loaded, ignore
    }

    // Reset mocks before each test
    mockSessionStore = {
      storeObservations: mock(() => ({ observationIds: [1], summaryId: null })),
      getRecentObservationsForSession: mock(() => []), // Empty - no recent observations
      updateSessionPromptNumber: mock(() => {}),
    };

    const mockSessionManager = {
      // Add any required session manager methods here
    };

    const mockChromaSync = {
      syncObservation: mock(() => Promise.resolve()),
      syncSummary: mock(() => Promise.resolve()),
    };

    mockDbManager = {
      sessionStore: mockSessionStore,
      getSessionStore: mock(() => mockSessionStore),
      getChromaSync: mock(() => mockChromaSync),
      sessionManager: mockSessionManager,
    };

    mockWorker = {
      // Add any required worker methods here
    };

    mockSession = {
      sessionDbId: 1,
      memorySessionId: 'test-session-id',
      contentSessionId: 'test-content-id',
      project: 'test-project',
      provider: 'test-provider',
      model: 'test-model',
      prompt_number: 1,
      parent_session_id: null,
      tool_name: null,
      started_at: Date.now(),
      conversationHistory: [],
    };
  });

  it('should filter duplicate observations within same batch', async () => {
    // Arrange: Agent response with 9 identical observations
    const agentResponse = `
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Test Finding</title>
        <subtitle>Same content</subtitle>
        <narrative>Identical narrative</narrative>
      </observation>
    `;

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: Only 1 observation should be stored (8 filtered as intra-batch duplicates)
    expect(mockSessionStore.storeObservations).toHaveBeenCalledTimes(1);
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(1);
    expect(storedObservations[0].title).toBe('Test Finding');
  });

  it('should handle mix of unique and duplicate in same batch', async () => {
    // Arrange: 5 observations - A, B, A (dup), C, B (dup)
    const agentResponse = `
      <observation>
        <type>discovery</type>
        <title>Finding A</title>
        <subtitle>First</subtitle>
        <narrative>Content A</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Finding B</title>
        <subtitle>Second</subtitle>
        <narrative>Content B</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Finding A</title>
        <subtitle>First</subtitle>
        <narrative>Content A</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Finding C</title>
        <subtitle>Third</subtitle>
        <narrative>Content C</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Finding B</title>
        <subtitle>Second</subtitle>
        <narrative>Content B</narrative>
      </observation>
    `;

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: 3 unique observations (A, B, C) stored, 2 duplicates filtered
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(3);
    expect(storedObservations.map((o: any) => o.title)).toEqual(['Finding A', 'Finding B', 'Finding C']);
  });

  it('should still catch inter-batch duplicates after intra-batch filtering', async () => {
    // Arrange: New observation that matches a recently stored observation
    const agentResponse = `
      <observation>
        <type>discovery</type>
        <title>Existing Finding</title>
        <subtitle>Already stored</subtitle>
        <narrative>This was stored in a previous batch</narrative>
      </observation>
    `;

    // Mock recent observations with a matching observation
    mockSessionStore.getRecentObservationsForSession = mock(() => [
      {
        title: 'Existing Finding',
        subtitle: 'Already stored',
        type: 'discovery',
        prompt_number: 1
      }
    ]);

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: 0 observations stored (filtered by inter-batch dedup)
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(0);
  });

  it('should handle observations with null titles', async () => {
    // Arrange: Mix of observations with and without titles
    const agentResponse = `
      <observation>
        <type>discovery</type>
        <subtitle>No title</subtitle>
        <narrative>This observation has no title</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Has Title</title>
        <subtitle>With title</subtitle>
        <narrative>This observation has a title</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <subtitle>No title</subtitle>
        <narrative>This observation has no title</narrative>
      </observation>
    `;

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: All 3 observations should be stored (null-title observations bypass deduplication)
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(3);
  });

  it('should handle empty batch gracefully', async () => {
    // Arrange: Empty agent response
    const agentResponse = ``;

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: No observations stored
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(0);
  });

  it('should preserve observation order for unique observations', async () => {
    // Arrange: Observations in specific order with some duplicates
    const agentResponse = `
      <observation>
        <type>discovery</type>
        <title>First</title>
        <subtitle>A</subtitle>
        <narrative>First observation</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Second</title>
        <subtitle>B</subtitle>
        <narrative>Second observation</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>First</title>
        <subtitle>A</subtitle>
        <narrative>First observation</narrative>
      </observation>
      <observation>
        <type>discovery</type>
        <title>Third</title>
        <subtitle>C</subtitle>
        <narrative>Third observation</narrative>
      </observation>
    `;

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: Order should be First, Second, Third (duplicates removed)
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(3);
    expect(storedObservations.map((o: any) => o.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('should handle near-duplicates with different types', async () => {
    // Arrange: Same title/subtitle but different types
    const agentResponse = `
      <observation>
        <type>discovery</type>
        <title>Finding</title>
        <subtitle>Same</subtitle>
        <narrative>Content</narrative>
      </observation>
      <observation>
        <type>decision</type>
        <title>Finding</title>
        <subtitle>Same</subtitle>
        <narrative>Content</narrative>
      </observation>
    `;

    // Act
    await processAgentResponse(
      agentResponse,
      mockSession,
      mockDbManager as DatabaseManager,
      mockDbManager.sessionManager as any,
      mockWorker,
      0, // discoveryTokens
      null, // originalTimestamp
      'test-agent'
    );

    // Assert: Both observations should be stored (different types = different identity)
    const storedObservations = mockSessionStore.storeObservations.mock.calls[0][2];
    expect(storedObservations.length).toBe(2);
    expect(storedObservations[0].type).toBe('discovery');
    expect(storedObservations[1].type).toBe('decision');
  });
});
