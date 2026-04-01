import { describe, expect, test } from 'bun:test';
import { detectStage, evaluateDrift } from '../src/judge/drift-evaluator.js';
import type { AgentState } from '../src/judge/state-reader.js';

function makeAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'cmem-01-test-1',
    containerStatus: 'running',
    isDone: false,
    isCrashed: false,
    isKilled: false,
    lastActivityTime: new Date(),
    fileCount: 10,
    elapsedSeconds: 3600, // 1 hour
    tokenUsage: null,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

describe('drift-evaluator', () => {
  describe('detectStage', () => {
    test('0 minutes -> planning', () => {
      expect(detectStage(0)).toBe('planning');
    });

    test('10 minutes -> planning', () => {
      expect(detectStage(10)).toBe('planning');
    });

    test('30 minutes -> scaffolding', () => {
      expect(detectStage(30)).toBe('scaffolding');
    });

    test('90 minutes -> building', () => {
      expect(detectStage(90)).toBe('building');
    });

    test('200 minutes -> integration', () => {
      expect(detectStage(200)).toBe('integration');
    });

    test('400 minutes -> polish', () => {
      expect(detectStage(400)).toBe('polish');
    });

    test('boundary: 15 minutes -> scaffolding', () => {
      expect(detectStage(15)).toBe('scaffolding');
    });

    test('boundary: 60 minutes -> building', () => {
      expect(detectStage(60)).toBe('building');
    });

    test('boundary: 180 minutes -> integration', () => {
      expect(detectStage(180)).toBe('integration');
    });

    test('boundary: 300 minutes -> polish', () => {
      expect(detectStage(300)).toBe('polish');
    });
  });

  describe('evaluateDrift', () => {
    test('active agent with recent activity -> on-track', () => {
      const state = makeAgentState({
        lastActivityTime: new Date(), // just now
        fileCount: 10,
        elapsedSeconds: 3600, // 1 hour, building stage
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('on-track');
      expect(assessment.stage).toBe('building');
    });

    test('agent with activity 20 minutes ago -> minor-deviation', () => {
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
      const state = makeAgentState({
        lastActivityTime: twentyMinutesAgo,
        fileCount: 10,
        elapsedSeconds: 3600,
      });

      const assessment = evaluateDrift(state);
      // 20 minutes ago is >= 15 min, so major-drift (15-30 range)
      expect(assessment.score).toBe('major-drift');
    });

    test('agent with activity 10 minutes ago -> minor-deviation', () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const state = makeAgentState({
        lastActivityTime: tenMinutesAgo,
        fileCount: 10,
        elapsedSeconds: 3600,
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('minor-deviation');
    });

    test('agent inactive 35 minutes -> unrecoverable', () => {
      const thirtyFiveMinutesAgo = new Date(Date.now() - 35 * 60 * 1000);
      const state = makeAgentState({
        lastActivityTime: thirtyFiveMinutesAgo,
        fileCount: 10,
        elapsedSeconds: 3600,
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('unrecoverable');
    });

    test('done agent -> on-track regardless of activity', () => {
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      const state = makeAgentState({
        isDone: true,
        lastActivityTime: longAgo,
        elapsedSeconds: 7200,
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('on-track');
      expect(assessment.reasoning).toContain('completed successfully');
    });

    test('crashed agent -> unrecoverable', () => {
      const state = makeAgentState({
        isCrashed: true,
        containerStatus: 'dead',
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('unrecoverable');
      expect(assessment.reasoning).toContain('crashed');
    });

    test('killed agent -> unrecoverable', () => {
      const state = makeAgentState({
        isKilled: true,
        containerStatus: 'exited',
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('unrecoverable');
      expect(assessment.reasoning).toContain('killed');
    });

    test('exited container without sentinel -> unrecoverable', () => {
      const state = makeAgentState({
        containerStatus: 'exited',
        isDone: false,
        isCrashed: false,
        isKilled: false,
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('unrecoverable');
      expect(assessment.reasoning).toContain('without completion marker');
    });

    test('low file count in scaffolding stage -> major-drift', () => {
      const state = makeAgentState({
        lastActivityTime: new Date(), // active right now
        fileCount: 1, // below minimum of 3 for scaffolding
        elapsedSeconds: 30 * 60, // 30 min, scaffolding stage
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('major-drift');
      expect(assessment.reasoning).toContain('File count');
    });

    test('planning stage agent with 0 files is on-track', () => {
      const state = makeAgentState({
        lastActivityTime: new Date(),
        fileCount: 0,
        elapsedSeconds: 5 * 60, // 5 min, planning stage
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('on-track');
    });

    test('assessment includes correct elapsed minutes', () => {
      const state = makeAgentState({
        elapsedSeconds: 5400, // 90 minutes
        lastActivityTime: new Date(),
        fileCount: 10,
      });

      const assessment = evaluateDrift(state);
      expect(assessment.elapsedMinutes).toBe(90);
    });

    test('assessment includes agent id', () => {
      const state = makeAgentState({
        agentId: 'vanilla-05-test-2',
        lastActivityTime: new Date(),
      });

      const assessment = evaluateDrift(state);
      expect(assessment.agentId).toBe('vanilla-05-test-2');
    });

    test('no activity time (null) and running -> unrecoverable', () => {
      const state = makeAgentState({
        lastActivityTime: null,
        containerStatus: 'running',
      });

      const assessment = evaluateDrift(state);
      expect(assessment.score).toBe('unrecoverable');
    });
  });
});
