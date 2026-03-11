import { describe, it, expect, beforeEach } from 'bun:test';
import { SAMPLE_CONFIG } from '../../src/services/transcripts/config.js';
import type { TranscriptSchema, SchemaEvent } from '../../src/services/transcripts/types.js';

/**
 * Tests for Codex Transcript Schema
 *
 * These tests validate the CODEX_SAMPLE_SCHEMA structure to ensure it correctly
 * maps Codex CLI transcript events to claude-mem actions. This locks down the
 * schema behavior to prevent drift as the codebase evolves.
 *
 * Codex transcript format: ~/.codex/sessions/*.jsonl
 * Each line is a JSON event with { type, payload, timestamp }
 */

describe('Codex Transcript Schema', () => {
  let codexSchema: TranscriptSchema;

  beforeEach(() => {
    codexSchema = SAMPLE_CONFIG.schemas!.codex;
  });

  it('should have correct schema metadata', () => {
    expect(codexSchema.name).toBe('codex');
    expect(codexSchema.version).toBe('0.2');
    expect(codexSchema.description).toContain('Codex session JSONL');
  });

  it('should define all 7 expected event types', () => {
    expect(codexSchema.events).toHaveLength(7);

    const eventNames = codexSchema.events.map(e => e.name);
    expect(eventNames).toEqual([
      'session-meta',
      'turn-context',
      'user-message',
      'assistant-message',
      'tool-use',
      'tool-result',
      'session-end'
    ]);
  });

  describe('session-meta event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[0];
    });

    it('should match session_meta type', () => {
      expect(event.name).toBe('session-meta');
      expect(event.match?.path).toBe('type');
      expect(event.match?.equals).toBe('session_meta');
    });

    it('should map to session_context action', () => {
      expect(event.action).toBe('session_context');
    });

    it('should extract sessionId and cwd fields', () => {
      expect(event.fields?.sessionId).toBe('payload.id');
      expect(event.fields?.cwd).toBe('payload.cwd');
    });
  });

  describe('turn-context event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[1];
    });

    it('should match turn_context type', () => {
      expect(event.name).toBe('turn-context');
      expect(event.match?.path).toBe('type');
      expect(event.match?.equals).toBe('turn_context');
    });

    it('should map to session_context action', () => {
      expect(event.action).toBe('session_context');
    });

    it('should extract cwd field', () => {
      expect(event.fields?.cwd).toBe('payload.cwd');
    });
  });

  describe('user-message event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[2];
    });

    it('should match user_message payload type', () => {
      expect(event.name).toBe('user-message');
      expect(event.match?.path).toBe('payload.type');
      expect(event.match?.equals).toBe('user_message');
    });

    it('should map to session_init action', () => {
      expect(event.action).toBe('session_init');
    });

    it('should extract prompt field', () => {
      expect(event.fields?.prompt).toBe('payload.message');
    });
  });

  describe('assistant-message event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[3];
    });

    it('should match agent_message payload type', () => {
      expect(event.name).toBe('assistant-message');
      expect(event.match?.path).toBe('payload.type');
      expect(event.match?.equals).toBe('agent_message');
    });

    it('should map to assistant_message action', () => {
      expect(event.action).toBe('assistant_message');
    });

    it('should extract message field', () => {
      expect(event.fields?.message).toBe('payload.message');
    });
  });

  describe('tool-use event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[4];
    });

    it('should match multiple tool call types', () => {
      expect(event.name).toBe('tool-use');
      expect(event.match?.path).toBe('payload.type');
      expect(event.match?.in).toEqual([
        'function_call',
        'custom_tool_call',
        'web_search_call'
      ]);
    });

    it('should map to tool_use action', () => {
      expect(event.action).toBe('tool_use');
    });

    it('should extract toolId from call_id', () => {
      expect(event.fields?.toolId).toBe('payload.call_id');
    });

    it('should use coalesce for toolName with web_search fallback', () => {
      const toolNameSpec = event.fields?.toolName as any;
      expect(toolNameSpec.coalesce).toBeDefined();
      expect(toolNameSpec.coalesce).toHaveLength(2);
      expect(toolNameSpec.coalesce[0]).toBe('payload.name');
      expect(toolNameSpec.coalesce[1]).toEqual({ value: 'web_search' });
    });

    it('should use coalesce for toolInput from multiple sources', () => {
      const toolInputSpec = event.fields?.toolInput as any;
      expect(toolInputSpec.coalesce).toBeDefined();
      expect(toolInputSpec.coalesce).toEqual([
        'payload.arguments',
        'payload.input',
        'payload.action'
      ]);
    });
  });

  describe('tool-result event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[5];
    });

    it('should match tool output types', () => {
      expect(event.name).toBe('tool-result');
      expect(event.match?.path).toBe('payload.type');
      expect(event.match?.in).toEqual([
        'function_call_output',
        'custom_tool_call_output'
      ]);
    });

    it('should map to tool_result action', () => {
      expect(event.action).toBe('tool_result');
    });

    it('should extract toolId and toolResponse', () => {
      expect(event.fields?.toolId).toBe('payload.call_id');
      expect(event.fields?.toolResponse).toBe('payload.output');
    });
  });

  describe('session-end event', () => {
    let event: SchemaEvent;

    beforeEach(() => {
      event = codexSchema.events[6];
    });

    it('should match turn_aborted and task_complete types', () => {
      expect(event.name).toBe('session-end');
      expect(event.match?.path).toBe('payload.type');
      expect(event.match?.in).toEqual(['turn_aborted', 'task_complete']);
    });

    it('should map to session_end action', () => {
      expect(event.action).toBe('session_end');
    });

    it('should have no fields', () => {
      expect(event.fields).toBeUndefined();
    });
  });

  describe('SAMPLE_CONFIG structure', () => {
    it('should have version 1', () => {
      expect(SAMPLE_CONFIG.version).toBe(1);
    });

    it('should include codex schema in schemas map', () => {
      expect(SAMPLE_CONFIG.schemas).toBeDefined();
      expect(SAMPLE_CONFIG.schemas!.codex).toBe(codexSchema);
    });

    it('should define watch configuration for Codex', () => {
      expect(SAMPLE_CONFIG.watches).toHaveLength(1);

      const watch = SAMPLE_CONFIG.watches[0];
      expect(watch.name).toBe('codex');
      expect(watch.path).toBe('~/.codex/sessions/**/*.jsonl');
      expect(watch.schema).toBe('codex');
      expect(watch.startAtEnd).toBe(true);
    });

    it('should configure AGENTS.md context injection', () => {
      const watch = SAMPLE_CONFIG.watches[0];
      expect(watch.context).toBeDefined();
      expect(watch.context?.mode).toBe('agents');
      expect(watch.context?.path).toBe('~/.codex/AGENTS.md');
      expect(watch.context?.updateOn).toEqual(['session_start', 'session_end']);
    });

    it('should specify state file path', () => {
      expect(SAMPLE_CONFIG.stateFile).toContain('transcript-watch-state.json');
    });
  });
});
