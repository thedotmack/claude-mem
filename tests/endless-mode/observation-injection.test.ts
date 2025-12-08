/**
 * Endless Mode v7.1 - Observation Injection Tests
 *
 * Tests the observation formatting and injection logic in save-hook.ts
 * Validates markdown formatting, transcript clearing, and additionalContext field.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatObservationAsMarkdown, clearToolInputInTranscript } from '../../src/hooks/context-injection';
import { ObservationRow } from '../../src/services/sqlite/types';
import { writeFile, readFile, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Endless Mode v7.1 - Observation Injection', () => {
  describe('formatObservationAsMarkdown()', () => {
    it('should format a basic observation with all fields', () => {
      const obs: ObservationRow = {
        id: 22001,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_001',
        type: 'bugfix',
        title: 'Fixed parser bug',
        subtitle: 'XML parser self-closing tags',
        narrative: 'The XML parser was not handling empty tags correctly. Added check for self-closing tags.',
        facts: JSON.stringify(['Bug in parser.ts:42', 'Self-closing tags broken', 'Added regex check']),
        concepts: JSON.stringify(['bugfix', 'parser', 'xml']),
        files_read: JSON.stringify(['/project/src/parser.ts']),
        files_modified: JSON.stringify(['/project/src/parser.ts']),
        text: 'Full observation text here...'.repeat(100), // ~3000 chars = ~750 tokens
        discovery_tokens: 1500,
        created_at_epoch: Date.now()
      };

      const markdown = formatObservationAsMarkdown(obs);

      // Assertions
      expect(markdown).toContain('**#22001**');
      expect(markdown).toContain('🔴'); // bugfix emoji
      expect(markdown).toContain('**Fixed parser bug**');
      expect(markdown).toContain('XML parser self-closing tags');
      expect(markdown).toContain('The XML parser was not handling');
      expect(markdown).toContain('**Facts:**');
      expect(markdown).toContain('- Bug in parser.ts:42');
      expect(markdown).toContain('- Self-closing tags broken');
      expect(markdown).toContain('**Concepts:** bugfix, parser, xml');
      expect(markdown).toContain('**Files:**');
      expect(markdown).toContain('Read: /project/src/parser.ts');
      expect(markdown).toContain('Modified: /project/src/parser.ts');
      // Token count is approximate (text.length / 4 rounded up)
      expect(markdown).toMatch(/Read: ~\d+/);
      expect(markdown).toContain('Work: 🔍 1500');
    });

    it('should format feature observation with correct emoji', () => {
      const obs: ObservationRow = {
        id: 22002,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_002',
        type: 'feature',
        title: 'Added search functionality',
        subtitle: null,
        narrative: 'Implemented full-text search using FTS5.',
        facts: JSON.stringify(['Added FTS5 virtual table', 'Search API endpoint created']),
        concepts: JSON.stringify(['feature', 'search', 'fts5']),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify(['/project/src/services/search.ts']),
        text: 'Search implementation details...',
        discovery_tokens: 800,
        created_at_epoch: Date.now()
      };

      const markdown = formatObservationAsMarkdown(obs);

      expect(markdown).toContain('🟣'); // feature emoji
      expect(markdown).toContain('**Added search functionality**');
      expect(markdown).not.toContain('null'); // subtitle should be omitted
    });

    it('should format decision observation with correct emoji', () => {
      const obs: ObservationRow = {
        id: 22003,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_003',
        type: 'decision',
        title: 'Chose SQLite over PostgreSQL',
        subtitle: null,
        narrative: 'Decided to use SQLite for simpler deployment.',
        facts: JSON.stringify(['No external dependencies', 'File-based storage', 'FTS5 support']),
        concepts: JSON.stringify(['decision', 'database', 'sqlite']),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify([]),
        text: 'Decision rationale...',
        discovery_tokens: 500,
        created_at_epoch: Date.now()
      };

      const markdown = formatObservationAsMarkdown(obs);

      expect(markdown).toContain('⚖️'); // decision emoji
      expect(markdown).toContain('**Chose SQLite over PostgreSQL**');
    });

    it('should handle observation with no facts or concepts', () => {
      const obs: ObservationRow = {
        id: 22004,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_004',
        type: 'discovery',
        title: 'Found caching layer',
        subtitle: null,
        narrative: 'Discovered existing Redis cache implementation.',
        facts: JSON.stringify([]),
        concepts: JSON.stringify([]),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify([]),
        text: 'Discovery details...',
        discovery_tokens: 300,
        created_at_epoch: Date.now()
      };

      const markdown = formatObservationAsMarkdown(obs);

      expect(markdown).toContain('🔵'); // discovery emoji
      expect(markdown).not.toContain('**Facts:**');
      expect(markdown).not.toContain('**Concepts:**');
      expect(markdown).not.toContain('**Files:**');
    });

    it('should handle observation with malformed JSON gracefully', () => {
      const obs: ObservationRow = {
        id: 22005,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_005',
        type: 'refactor',
        title: 'Refactored auth logic',
        subtitle: null,
        narrative: 'Extracted auth middleware.',
        facts: 'INVALID_JSON{not:json}', // Malformed
        concepts: 'ALSO_INVALID', // Malformed
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify([]),
        text: 'Refactor details...',
        discovery_tokens: 400,
        created_at_epoch: Date.now()
      };

      const markdown = formatObservationAsMarkdown(obs);

      expect(markdown).toContain('🔄'); // refactor emoji
      expect(markdown).toContain('**Refactored auth logic**');
      // Should not crash, just skip malformed fields
      expect(markdown).not.toContain('**Facts:**');
      expect(markdown).not.toContain('**Concepts:**');
    });

    it('should format change observation', () => {
      const obs: ObservationRow = {
        id: 22006,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_006',
        type: 'change',
        title: 'Updated dependencies',
        subtitle: null,
        narrative: 'Upgraded Vitest to 4.0.15.',
        facts: JSON.stringify(['vitest: 3.x -> 4.0.15', 'Breaking changes handled']),
        concepts: JSON.stringify(['dependencies', 'upgrade']),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify(['/project/package.json']),
        text: 'Upgrade details...',
        discovery_tokens: 200,
        created_at_epoch: Date.now()
      };

      const markdown = formatObservationAsMarkdown(obs);

      expect(markdown).toContain('✅'); // change emoji
      expect(markdown).toContain('**Updated dependencies**');
    });
  });

  describe('Multiple observations formatting', () => {
    it('should format multiple observations with --- separator', () => {
      const obs1: ObservationRow = {
        id: 22007,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_007',
        type: 'bugfix',
        title: 'First observation',
        subtitle: null,
        narrative: 'First',
        facts: JSON.stringify(['Fact 1']),
        concepts: JSON.stringify(['concept1']),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify([]),
        text: 'First obs',
        discovery_tokens: 100,
        created_at_epoch: Date.now()
      };

      const obs2: ObservationRow = {
        id: 22008,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_007',
        type: 'feature',
        title: 'Second observation',
        subtitle: null,
        narrative: 'Second',
        facts: JSON.stringify(['Fact 2']),
        concepts: JSON.stringify(['concept2']),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify([]),
        text: 'Second obs',
        discovery_tokens: 200,
        created_at_epoch: Date.now()
      };

      const obs3: ObservationRow = {
        id: 22009,
        sdk_session_id: 1,
        tool_use_id: 'toolu_test_007',
        type: 'discovery',
        title: 'Third observation',
        subtitle: null,
        narrative: 'Third',
        facts: JSON.stringify(['Fact 3']),
        concepts: JSON.stringify(['concept3']),
        files_read: JSON.stringify([]),
        files_modified: JSON.stringify([]),
        text: 'Third obs',
        discovery_tokens: 300,
        created_at_epoch: Date.now()
      };

      const formatted1 = formatObservationAsMarkdown(obs1);
      const formatted2 = formatObservationAsMarkdown(obs2);
      const formatted3 = formatObservationAsMarkdown(obs3);

      const combined = [formatted1, formatted2, formatted3].join('\n\n---\n\n');

      // Assertions
      expect(combined).toContain('**#22007**');
      expect(combined).toContain('**#22008**');
      expect(combined).toContain('**#22009**');
      expect(combined).toContain('\n\n---\n\n');

      // Count separators (should be 2 for 3 observations)
      const separatorCount = (combined.match(/\n\n---\n\n/g) || []).length;
      expect(separatorCount).toBe(2);
    });
  });

  describe('clearToolInputInTranscript()', () => {
    let tempTranscriptPath: string;

    beforeEach(async () => {
      // Create temporary transcript file
      tempTranscriptPath = path.join(os.tmpdir(), `transcript-${Date.now()}.json`);
    });

    afterEach(async () => {
      // Clean up
      try {
        await unlink(tempTranscriptPath);
      } catch {
        // Ignore if already deleted
      }
    });

    it('should clear tool input for matching tool_use_id', async () => {
      const transcript = [
        {
          role: 'user',
          content: 'Run git status'
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'I will run git status'
            },
            {
              type: 'tool_use',
              id: 'toolu_abc123',
              name: 'Bash',
              input: {
                command: 'git status',
                description: 'Check git status'
              }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_abc123',
              content: 'On branch main\nnothing to commit'
            }
          ]
        }
      ];

      await writeFile(tempTranscriptPath, JSON.stringify(transcript, null, 2), 'utf-8');

      // Clear the tool input
      const tokensSaved = await clearToolInputInTranscript(tempTranscriptPath, 'toolu_abc123');

      // Read back
      const updatedContent = await readFile(tempTranscriptPath, 'utf-8');
      const updatedTranscript = JSON.parse(updatedContent);

      // Find the tool_use block
      const assistantMessage = updatedTranscript[1];
      const toolUseBlock = assistantMessage.content.find((b: any) => b.type === 'tool_use' && b.id === 'toolu_abc123');

      // Assertions
      expect(toolUseBlock).toBeDefined();
      expect(toolUseBlock.input).toEqual({}); // Should be cleared
      expect(tokensSaved).toBeGreaterThan(0); // Should save some tokens
    });

    it('should not modify transcript if tool_use_id not found', async () => {
      const transcript = [
        {
          role: 'user',
          content: 'Hello'
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Hi there'
            }
          ]
        }
      ];

      await writeFile(tempTranscriptPath, JSON.stringify(transcript, null, 2), 'utf-8');

      const tokensSaved = await clearToolInputInTranscript(tempTranscriptPath, 'toolu_nonexistent');

      const updatedContent = await readFile(tempTranscriptPath, 'utf-8');
      const updatedTranscript = JSON.parse(updatedContent);

      // Should be unchanged
      expect(updatedTranscript).toEqual(transcript);
      expect(tokensSaved).toBe(0);
    });

    it('should handle transcript with multiple tool uses correctly', async () => {
      const transcript = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_first',
              name: 'Read',
              input: {
                file_path: '/project/src/index.ts'
              }
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_second',
              name: 'Edit',
              input: {
                file_path: '/project/src/index.ts',
                old_string: 'const PORT = 3000;',
                new_string: 'const PORT = 8080;'
              }
            }
          ]
        }
      ];

      await writeFile(tempTranscriptPath, JSON.stringify(transcript, null, 2), 'utf-8');

      // Clear only the second tool use
      await clearToolInputInTranscript(tempTranscriptPath, 'toolu_second');

      const updatedContent = await readFile(tempTranscriptPath, 'utf-8');
      const updatedTranscript = JSON.parse(updatedContent);

      // First should be unchanged
      const firstToolUse = updatedTranscript[0].content[0];
      expect(firstToolUse.input).toEqual({
        file_path: '/project/src/index.ts'
      });

      // Second should be cleared
      const secondToolUse = updatedTranscript[1].content[0];
      expect(secondToolUse.input).toEqual({});
    });

    it('should estimate tokens saved correctly', async () => {
      const largeInput = {
        command: 'echo ' + 'a'.repeat(1000),
        description: 'Long command'
      };

      const transcript = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_large',
              name: 'Bash',
              input: largeInput
            }
          ]
        }
      ];

      await writeFile(tempTranscriptPath, JSON.stringify(transcript, null, 2), 'utf-8');

      const tokensSaved = await clearToolInputInTranscript(tempTranscriptPath, 'toolu_large');

      // Input is ~1000+ characters, so tokens saved should be ~250+
      expect(tokensSaved).toBeGreaterThan(200);
    });

    it('should handle errors gracefully without throwing', async () => {
      const invalidPath = '/nonexistent/transcript.json';

      // Should not throw
      const tokensSaved = await clearToolInputInTranscript(invalidPath, 'toolu_test');

      expect(tokensSaved).toBe(0);
    });

    it('should handle malformed JSON gracefully', async () => {
      await writeFile(tempTranscriptPath, 'INVALID_JSON{not:json}', 'utf-8');

      // Should not throw
      const tokensSaved = await clearToolInputInTranscript(tempTranscriptPath, 'toolu_test');

      expect(tokensSaved).toBe(0);
    });
  });

  describe('End-to-end observation injection flow', () => {
    it('should format multiple observations correctly for additionalContext', () => {
      const observations: ObservationRow[] = [
        {
          id: 22010,
          sdk_session_id: 1,
          tool_use_id: 'toolu_test_010',
          type: 'bugfix',
          title: 'Fixed authentication bug',
          subtitle: null,
          narrative: 'JWT token validation was broken.',
          facts: JSON.stringify(['Token expiry check failed', 'Fixed in auth.ts:102']),
          concepts: JSON.stringify(['auth', 'jwt', 'bugfix']),
          files_read: JSON.stringify(['/project/src/auth.ts']),
          files_modified: JSON.stringify(['/project/src/auth.ts']),
          text: 'Bug details...',
          discovery_tokens: 600,
          created_at_epoch: Date.now()
        },
        {
          id: 22011,
          sdk_session_id: 1,
          tool_use_id: 'toolu_test_010',
          type: 'feature',
          title: 'Added refresh token support',
          subtitle: null,
          narrative: 'Implemented refresh token rotation.',
          facts: JSON.stringify(['New /refresh endpoint', 'Rotation every 7 days']),
          concepts: JSON.stringify(['auth', 'refresh-token', 'feature']),
          files_read: JSON.stringify([]),
          files_modified: JSON.stringify(['/project/src/auth.ts', '/project/src/routes.ts']),
          text: 'Feature details...',
          discovery_tokens: 900,
          created_at_epoch: Date.now()
        }
      ];

      // Simulate the save-hook logic
      const additionalContext = observations
        .map(formatObservationAsMarkdown)
        .join('\n\n---\n\n');

      // Assertions
      expect(additionalContext).toContain('**#22010**');
      expect(additionalContext).toContain('**#22011**');
      expect(additionalContext).toContain('🔴'); // bugfix
      expect(additionalContext).toContain('🟣'); // feature
      expect(additionalContext).toContain('\n\n---\n\n'); // separator

      // Should be valid markdown
      expect(additionalContext).toMatch(/\*\*#\d+\*\*/);
      expect(additionalContext).toContain('**Facts:**');
      expect(additionalContext).toContain('**Concepts:**');
    });
  });
});
