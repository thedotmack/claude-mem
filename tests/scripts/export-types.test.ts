import { describe, it, expect } from 'bun:test';
import type {
  ObservationRecord,
  SdkSessionRecord,
  SessionSummaryRecord,
  UserPromptRecord,
  ExportData
} from '../../scripts/types/export.js';

describe('Export Types', () => {
  describe('ObservationRecord', () => {
    it('should have all required fields', () => {
      const observation: ObservationRecord = {
        id: 1,
        memory_session_id: 'session-123',
        project: 'test-project',
        text: null,
        type: 'discovery',
        title: 'Test Title',
        subtitle: null,
        facts: null,
        narrative: null,
        concepts: null,
        files_read: null,
        files_modified: null,
        prompt_number: 1,
        discovery_tokens: null,
        created_at: '2025-01-01T00:00:00Z',
        created_at_epoch: 1704067200
      };

      expect(observation.id).toBe(1);
      expect(observation.memory_session_id).toBe('session-123');
      expect(observation.project).toBe('test-project');
      expect(observation.type).toBe('discovery');
      expect(observation.title).toBe('Test Title');
      expect(observation.prompt_number).toBe(1);
      expect(observation.created_at).toBe('2025-01-01T00:00:00Z');
      expect(observation.created_at_epoch).toBe(1704067200);
    });

    it('should accept string values for nullable text fields', () => {
      const observation: ObservationRecord = {
        id: 2,
        memory_session_id: 'session-456',
        project: 'another-project',
        text: 'Full observation text content',
        type: 'session-summary',
        title: 'Summary Title',
        subtitle: 'A subtitle',
        facts: 'Fact 1, Fact 2',
        narrative: 'The narrative of what happened',
        concepts: 'concept1, concept2',
        files_read: 'file1.ts, file2.ts',
        files_modified: 'file3.ts',
        prompt_number: 5,
        discovery_tokens: 1500,
        created_at: '2025-06-15T12:30:00Z',
        created_at_epoch: 1718451000
      };

      expect(observation.text).toBe('Full observation text content');
      expect(observation.subtitle).toBe('A subtitle');
      expect(observation.facts).toBe('Fact 1, Fact 2');
      expect(observation.narrative).toBe('The narrative of what happened');
      expect(observation.concepts).toBe('concept1, concept2');
      expect(observation.files_read).toBe('file1.ts, file2.ts');
      expect(observation.files_modified).toBe('file3.ts');
      expect(observation.discovery_tokens).toBe(1500);
    });
  });

  describe('SdkSessionRecord', () => {
    it('should have all required fields', () => {
      const session: SdkSessionRecord = {
        id: 1,
        content_session_id: 'content-abc',
        memory_session_id: 'memory-xyz',
        project: 'test-project',
        user_prompt: 'User asked a question',
        started_at: '2025-01-01T10:00:00Z',
        started_at_epoch: 1704103200,
        completed_at: null,
        completed_at_epoch: null,
        status: 'in_progress'
      };

      expect(session.id).toBe(1);
      expect(session.content_session_id).toBe('content-abc');
      expect(session.memory_session_id).toBe('memory-xyz');
      expect(session.project).toBe('test-project');
      expect(session.user_prompt).toBe('User asked a question');
      expect(session.started_at).toBe('2025-01-01T10:00:00Z');
      expect(session.started_at_epoch).toBe(1704103200);
      expect(session.status).toBe('in_progress');
    });

    it('should accept completion values for nullable fields', () => {
      const session: SdkSessionRecord = {
        id: 2,
        content_session_id: 'content-def',
        memory_session_id: 'memory-uvw',
        project: 'completed-project',
        user_prompt: 'Complete this task',
        started_at: '2025-01-01T10:00:00Z',
        started_at_epoch: 1704103200,
        completed_at: '2025-01-01T10:30:00Z',
        completed_at_epoch: 1704105000,
        status: 'completed'
      };

      expect(session.completed_at).toBe('2025-01-01T10:30:00Z');
      expect(session.completed_at_epoch).toBe(1704105000);
      expect(session.status).toBe('completed');
    });
  });

  describe('SessionSummaryRecord', () => {
    it('should have all required fields', () => {
      const summary: SessionSummaryRecord = {
        id: 1,
        memory_session_id: 'session-summary-123',
        project: 'summary-project',
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        files_read: null,
        files_edited: null,
        notes: null,
        prompt_number: 1,
        discovery_tokens: null,
        created_at: '2025-01-01T14:00:00Z',
        created_at_epoch: 1704117600
      };

      expect(summary.id).toBe(1);
      expect(summary.memory_session_id).toBe('session-summary-123');
      expect(summary.project).toBe('summary-project');
      expect(summary.prompt_number).toBe(1);
      expect(summary.created_at).toBe('2025-01-01T14:00:00Z');
      expect(summary.created_at_epoch).toBe(1704117600);
    });

    it('should accept string values for all nullable summary fields', () => {
      const summary: SessionSummaryRecord = {
        id: 2,
        memory_session_id: 'session-full-summary',
        project: 'detailed-project',
        request: 'User requested feature X',
        investigated: 'Checked files A, B, C',
        learned: 'Discovered pattern D',
        completed: 'Implemented feature X',
        next_steps: 'Test and deploy',
        files_read: 'src/a.ts, src/b.ts',
        files_edited: 'src/c.ts',
        notes: 'Additional context here',
        prompt_number: 10,
        discovery_tokens: 2500,
        created_at: '2025-06-20T16:45:00Z',
        created_at_epoch: 1718901900
      };

      expect(summary.request).toBe('User requested feature X');
      expect(summary.investigated).toBe('Checked files A, B, C');
      expect(summary.learned).toBe('Discovered pattern D');
      expect(summary.completed).toBe('Implemented feature X');
      expect(summary.next_steps).toBe('Test and deploy');
      expect(summary.files_read).toBe('src/a.ts, src/b.ts');
      expect(summary.files_edited).toBe('src/c.ts');
      expect(summary.notes).toBe('Additional context here');
      expect(summary.discovery_tokens).toBe(2500);
    });
  });

  describe('UserPromptRecord', () => {
    it('should have all required fields', () => {
      const prompt: UserPromptRecord = {
        id: 1,
        content_session_id: 'content-prompt-123',
        prompt_number: 1,
        prompt_text: 'What is the meaning of life?',
        created_at: '2025-01-01T08:00:00Z',
        created_at_epoch: 1704096000
      };

      expect(prompt.id).toBe(1);
      expect(prompt.content_session_id).toBe('content-prompt-123');
      expect(prompt.prompt_number).toBe(1);
      expect(prompt.prompt_text).toBe('What is the meaning of life?');
      expect(prompt.created_at).toBe('2025-01-01T08:00:00Z');
      expect(prompt.created_at_epoch).toBe(1704096000);
    });

    it('should handle multi-line prompt text', () => {
      const prompt: UserPromptRecord = {
        id: 2,
        content_session_id: 'content-multiline',
        prompt_number: 3,
        prompt_text: 'Line 1\nLine 2\nLine 3',
        created_at: '2025-03-15T09:30:00Z',
        created_at_epoch: 1710495000
      };

      expect(prompt.prompt_text).toContain('\n');
      expect(prompt.prompt_number).toBe(3);
    });
  });

  describe('ExportData', () => {
    it('should compose all record types correctly', () => {
      const exportData: ExportData = {
        exportedAt: '2025-01-02T00:00:00Z',
        exportedAtEpoch: 1704153600,
        query: 'test query',
        totalObservations: 1,
        totalSessions: 1,
        totalSummaries: 1,
        totalPrompts: 1,
        observations: [{
          id: 1,
          memory_session_id: 'session-123',
          project: 'test-project',
          text: null,
          type: 'discovery',
          title: 'Test',
          subtitle: null,
          facts: null,
          narrative: null,
          concepts: null,
          files_read: null,
          files_modified: null,
          prompt_number: 1,
          discovery_tokens: null,
          created_at: '2025-01-01T00:00:00Z',
          created_at_epoch: 1704067200
        }],
        sessions: [{
          id: 1,
          content_session_id: 'content-abc',
          memory_session_id: 'memory-xyz',
          project: 'test-project',
          user_prompt: 'Question',
          started_at: '2025-01-01T10:00:00Z',
          started_at_epoch: 1704103200,
          completed_at: null,
          completed_at_epoch: null,
          status: 'in_progress'
        }],
        summaries: [{
          id: 1,
          memory_session_id: 'session-summary-123',
          project: 'summary-project',
          request: null,
          investigated: null,
          learned: null,
          completed: null,
          next_steps: null,
          files_read: null,
          files_edited: null,
          notes: null,
          prompt_number: 1,
          discovery_tokens: null,
          created_at: '2025-01-01T14:00:00Z',
          created_at_epoch: 1704117600
        }],
        prompts: [{
          id: 1,
          content_session_id: 'content-prompt-123',
          prompt_number: 1,
          prompt_text: 'Prompt text',
          created_at: '2025-01-01T08:00:00Z',
          created_at_epoch: 1704096000
        }]
      };

      expect(exportData.exportedAt).toBe('2025-01-02T00:00:00Z');
      expect(exportData.exportedAtEpoch).toBe(1704153600);
      expect(exportData.query).toBe('test query');
      expect(exportData.totalObservations).toBe(1);
      expect(exportData.totalSessions).toBe(1);
      expect(exportData.totalSummaries).toBe(1);
      expect(exportData.totalPrompts).toBe(1);
      expect(exportData.observations).toHaveLength(1);
      expect(exportData.sessions).toHaveLength(1);
      expect(exportData.summaries).toHaveLength(1);
      expect(exportData.prompts).toHaveLength(1);
    });

    it('should accept optional project field', () => {
      const exportWithProject: ExportData = {
        exportedAt: '2025-01-02T00:00:00Z',
        exportedAtEpoch: 1704153600,
        query: '*',
        project: 'specific-project',
        totalObservations: 0,
        totalSessions: 0,
        totalSummaries: 0,
        totalPrompts: 0,
        observations: [],
        sessions: [],
        summaries: [],
        prompts: []
      };

      expect(exportWithProject.project).toBe('specific-project');
    });

    it('should work without project field', () => {
      const exportWithoutProject: ExportData = {
        exportedAt: '2025-01-02T00:00:00Z',
        exportedAtEpoch: 1704153600,
        query: '*',
        totalObservations: 0,
        totalSessions: 0,
        totalSummaries: 0,
        totalPrompts: 0,
        observations: [],
        sessions: [],
        summaries: [],
        prompts: []
      };

      expect(exportWithoutProject.project).toBeUndefined();
    });

    it('should handle empty arrays', () => {
      const emptyExport: ExportData = {
        exportedAt: '2025-01-02T00:00:00Z',
        exportedAtEpoch: 1704153600,
        query: 'no results',
        totalObservations: 0,
        totalSessions: 0,
        totalSummaries: 0,
        totalPrompts: 0,
        observations: [],
        sessions: [],
        summaries: [],
        prompts: []
      };

      expect(emptyExport.observations).toHaveLength(0);
      expect(emptyExport.sessions).toHaveLength(0);
      expect(emptyExport.summaries).toHaveLength(0);
      expect(emptyExport.prompts).toHaveLength(0);
    });
  });
});
