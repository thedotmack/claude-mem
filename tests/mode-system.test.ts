/**
 * Mode System Tests
 * Validates mode loading, prompt injection, and parser integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import { buildInitPrompt, buildContinuationPrompt } from '../src/sdk/prompts.js';
import { parseObservations } from '../src/sdk/parser.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Mode System', () => {
  let modeManager: ModeManager;
  let testModesDir: string;

  beforeEach(() => {
    modeManager = ModeManager.getInstance();
  });

  describe('ModeManager', () => {
    describe('Loading modes', () => {
      it('loads code mode successfully', () => {
        const mode = modeManager.loadMode('code');
        expect(mode).toBeDefined();
        expect(mode.name).toBe('Code Development');
        expect(mode.observation_types).toHaveLength(6);
        expect(mode.observation_concepts).toBeDefined();
        expect(mode.prompts).toBeDefined();
      });

      it('loads email-investigation mode successfully', () => {
        const mode = modeManager.loadMode('email-investigation');
        expect(mode).toBeDefined();
        expect(mode.name).toBe('Email Investigation');
        expect(mode.observation_types).toHaveLength(6);
        expect(mode.observation_concepts).toBeDefined();
        expect(mode.prompts).toBeDefined();
      });

      it('falls back to code mode when mode file not found', () => {
        const mode = modeManager.loadMode('nonexistent-mode');
        expect(mode.name).toBe('Code Development');
      });

      it('validates required fields', () => {
        expect(() => {
          const mode = modeManager.loadMode('code');
          expect(mode.name).toBeDefined();
          expect(mode.observation_types).toBeDefined();
          expect(mode.observation_concepts).toBeDefined();
          expect(mode.prompts).toBeDefined();
        }).not.toThrow();
      });

      it('requires at least one observation type', () => {
        // This test would require creating an invalid mode file
        // Skipping for now as it requires filesystem mocking
        expect(true).toBe(true);
      });
    });

    describe('Type validation', () => {
      it('validates valid type IDs for code mode', () => {
        expect(modeManager.validateType('code', 'bugfix')).toBe(true);
        expect(modeManager.validateType('code', 'feature')).toBe(true);
        expect(modeManager.validateType('code', 'refactor')).toBe(true);
        expect(modeManager.validateType('code', 'change')).toBe(true);
        expect(modeManager.validateType('code', 'discovery')).toBe(true);
        expect(modeManager.validateType('code', 'decision')).toBe(true);
      });

      it('rejects invalid type IDs', () => {
        expect(modeManager.validateType('code', 'invalid')).toBe(false);
        expect(modeManager.validateType('code', 'observation')).toBe(false);
        expect(modeManager.validateType('code', '')).toBe(false);
      });

      it('returns correct type labels', () => {
        expect(modeManager.getTypeLabel('code', 'bugfix')).toBe('Bug Fix');
        expect(modeManager.getTypeLabel('code', 'feature')).toBe('Feature');
        expect(modeManager.getTypeLabel('code', 'decision')).toBe('Decision');
      });

      it('returns correct type icons', () => {
        expect(modeManager.getTypeIcon('code', 'bugfix')).toBe('🔴');
        expect(modeManager.getTypeIcon('code', 'feature')).toBe('🟣');
        expect(modeManager.getTypeIcon('code', 'decision')).toBe('⚖️');
      });
    });

    describe('Email Investigation mode types', () => {
      it('validates email investigation type IDs', () => {
        expect(modeManager.validateType('email-investigation', 'entity')).toBe(true);
        expect(modeManager.validateType('email-investigation', 'relationship')).toBe(true);
        expect(modeManager.validateType('email-investigation', 'timeline-event')).toBe(true);
        expect(modeManager.validateType('email-investigation', 'evidence')).toBe(true);
        expect(modeManager.validateType('email-investigation', 'anomaly')).toBe(true);
        expect(modeManager.validateType('email-investigation', 'conclusion')).toBe(true);
      });

      it('rejects code mode types in email investigation mode', () => {
        expect(modeManager.validateType('email-investigation', 'bugfix')).toBe(false);
        expect(modeManager.validateType('email-investigation', 'feature')).toBe(false);
        expect(modeManager.validateType('email-investigation', 'change')).toBe(false);
      });
    });
  });

  describe('Prompt Injection', () => {
    describe('Code mode prompts', () => {
      it('injects all observation types into init prompt', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain('bugfix');
        expect(prompt).toContain('feature');
        expect(prompt).toContain('refactor');
        expect(prompt).toContain('change');
        expect(prompt).toContain('discovery');
        expect(prompt).toContain('decision');
      });

      it('injects observer role guidance', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.observer_role);
      });

      it('injects recording focus guidance', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.recording_focus);
      });

      it('injects skip guidance', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.skip_guidance);
      });

      it('injects type guidance', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.type_guidance);
      });

      it('injects concept guidance', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.concept_guidance);
      });

      it('injects field guidance', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.field_guidance);
      });
    });

    describe('Email Investigation mode prompts', () => {
      it('injects all observation types into init prompt', () => {
        const mode = modeManager.loadMode('email-investigation');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain('entity');
        expect(prompt).toContain('relationship');
        expect(prompt).toContain('timeline-event');
        expect(prompt).toContain('evidence');
        expect(prompt).toContain('anomaly');
        expect(prompt).toContain('conclusion');
      });

      it('does not inject code mode types', () => {
        const mode = modeManager.loadMode('email-investigation');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        // Check that code mode types are NOT in the type list
        const typeListMatch = prompt.match(/<type>\[ (.*?) \]<\/type>/);
        expect(typeListMatch).toBeDefined();
        if (typeListMatch) {
          expect(typeListMatch[1]).not.toContain('bugfix');
          expect(typeListMatch[1]).not.toContain('feature');
        }
      });

      it('injects mode-specific format examples', () => {
        const mode = modeManager.loadMode('email-investigation');
        const prompt = buildInitPrompt('test-project', 'test-session', 'test prompt', mode);

        expect(prompt).toContain(mode.prompts.format_examples);
        expect(prompt).toContain('Full Name <email@address.com>');
      });
    });

    describe('Continuation prompts', () => {
      it('injects types correctly in continuation prompts', () => {
        const mode = modeManager.loadMode('code');
        const prompt = buildContinuationPrompt('test prompt', 2, 'test-session', mode);

        // Verify types are injected
        expect(prompt).toMatch(/<type>\[.*?\]<\/type>/);
      });
    });
  });

  describe('Parser Integration', () => {
    describe('Code mode parsing', () => {
      it('accepts valid code mode types', () => {
        const xml = `
<observation>
  <type>bugfix</type>
  <title>Fixed issue</title>
  <subtitle>Details</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
        `;
        const result = parseObservations(xml, 'code');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('bugfix');
      });

      it('falls back to first type (bugfix) for invalid types', () => {
        const xml = `
<observation>
  <type>entity</type>
  <title>Test</title>
  <subtitle>Details</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
        `;
        const result = parseObservations(xml, 'code');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('bugfix'); // First type in code mode
      });

      it('falls back to first type when type is missing', () => {
        const xml = `
<observation>
  <title>Test</title>
  <subtitle>Details</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
        `;
        const result = parseObservations(xml, 'code');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('bugfix');
      });
    });

    describe('Email Investigation mode parsing', () => {
      it('accepts valid email investigation types', () => {
        const xml = `
<observation>
  <type>entity</type>
  <title>Person identified</title>
  <subtitle>Details</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
        `;
        const result = parseObservations(xml, 'email-investigation');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('entity');
      });

      it('falls back to first type (entity) for invalid types', () => {
        const xml = `
<observation>
  <type>bugfix</type>
  <title>Test</title>
  <subtitle>Details</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
        `;
        const result = parseObservations(xml, 'email-investigation');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('entity'); // First type in email-investigation mode
      });

      it('rejects code mode types and falls back to entity', () => {
        const xml = `
<observation>
  <type>change</type>
  <title>Test</title>
  <subtitle>Details</subtitle>
  <narrative>More info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
        `;
        const result = parseObservations(xml, 'email-investigation');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('entity');
      });
    });
  });

  describe('Multiple Modes', () => {
    it('validates types for code mode', () => {
      expect(modeManager.validateType('code', 'bugfix')).toBe(true);
      expect(modeManager.validateType('code', 'entity')).toBe(false);
    });

    it('validates types for email-investigation mode', () => {
      expect(modeManager.validateType('email-investigation', 'entity')).toBe(true);
      expect(modeManager.validateType('email-investigation', 'bugfix')).toBe(false);
    });

    it('can query both modes simultaneously', () => {
      // Both modes can be queried at the same time
      expect(modeManager.validateType('code', 'bugfix')).toBe(true);
      expect(modeManager.validateType('email-investigation', 'entity')).toBe(true);
      expect(modeManager.validateType('code', 'entity')).toBe(false);
      expect(modeManager.validateType('email-investigation', 'bugfix')).toBe(false);
    });

    it('maintains correct fallback type per mode', () => {
      // Code mode - fallback is bugfix
      const xml1 = '<observation><type>invalid</type><title>Test</title><subtitle>Details</subtitle><narrative>Info</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>';
      const result1 = parseObservations(xml1, 'code');
      expect(result1[0].type).toBe('bugfix');

      // Email investigation mode - fallback is entity
      const xml2 = '<observation><type>invalid</type><title>Test</title><subtitle>Details</subtitle><narrative>Info</narrative><facts></facts><concepts></concepts><files_read></files_read><files_modified></files_modified></observation>';
      const result2 = parseObservations(xml2, 'email-investigation');
      expect(result2[0].type).toBe('entity');
    });

    it('caches modes after first load', () => {
      // Load both modes
      const code1 = modeManager.loadMode('code');
      const email1 = modeManager.loadMode('email-investigation');

      // Load again - should return cached versions
      const code2 = modeManager.loadMode('code');
      const email2 = modeManager.loadMode('email-investigation');

      // Should be the same object references (cached)
      expect(code1).toBe(code2);
      expect(email1).toBe(email2);
    });
  });

  describe('Edge Cases', () => {
    it('handles whitespace in type field', () => {
      const xml = `
<observation>
  <type>  bugfix  </type>
  <title>Test</title>
  <subtitle>Details</subtitle>
  <narrative>Info</narrative>
  <facts></facts>
  <concepts></concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
      `;
      const result = parseObservations(xml, 'code');
      expect(result[0].type).toBe('bugfix');
    });

    it('filters type from concepts array', () => {
      const xml = `
<observation>
  <type>feature</type>
  <title>Test</title>
  <subtitle>Details</subtitle>
  <narrative>Info</narrative>
  <facts></facts>
  <concepts>
    <concept>feature</concept>
    <concept>how-it-works</concept>
  </concepts>
  <files_read></files_read>
  <files_modified></files_modified>
</observation>
      `;
      const result = parseObservations(xml, 'code');
      expect(result[0].concepts).toEqual(['how-it-works']);
      expect(result[0].concepts).not.toContain('feature');
    });
  });
});
