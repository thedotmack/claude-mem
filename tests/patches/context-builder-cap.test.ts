import { beforeEach, describe, expect, it, mock } from 'bun:test';

let defaultConfig: any;
let observations: any[];
let summaries: any[];
let headerLines: string[];
let timelineLines: string[];
let summaryLines: string[];
let previouslyLines: string[];
let footerLines: string[];
let capturedConfigs: Array<{ totalObservationCount: number; sessionCount: number }>;

function recordConfig(config: any): void {
  capturedConfigs.push({
    totalObservationCount: config.totalObservationCount,
    sessionCount: config.sessionCount,
  });
}

mock.module('../../src/services/sqlite/SessionStore.js', () => ({
  SessionStore: class {
    close(): void {}
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectName: () => 'demo-project',
}));

mock.module('../../src/services/context/ContextConfigLoader.js', () => ({
  loadContextConfig: () => ({ ...defaultConfig }),
}));

mock.module('../../src/services/context/TokenCalculator.js', () => ({
  calculateTokenEconomics: () => ({ totalTokens: 0 }),
}));

mock.module('../../src/services/context/ObservationCompiler.js', () => ({
  queryObservations: (_db: unknown, _project: string, config: any) => {
    recordConfig(config);
    return observations;
  },
  queryObservationsMulti: (_db: unknown, _projects: string[], config: any) => {
    recordConfig(config);
    return observations;
  },
  querySummaries: (_db: unknown, _project: string, config: any) => {
    recordConfig(config);
    return summaries;
  },
  querySummariesMulti: (_db: unknown, _projects: string[], config: any) => {
    recordConfig(config);
    return summaries;
  },
  getPriorSessionMessages: () => [],
  prepareSummariesForTimeline: () => [],
  buildTimeline: () => [],
  getFullObservationIds: () => [],
}));

mock.module('../../src/services/context/sections/HeaderRenderer.js', () => ({
  renderHeader: () => headerLines,
}));

mock.module('../../src/services/context/sections/TimelineRenderer.js', () => ({
  renderTimeline: () => timelineLines,
}));

mock.module('../../src/services/context/sections/SummaryRenderer.js', () => ({
  shouldShowSummary: () => summaryLines.length > 0,
  renderSummaryFields: () => summaryLines,
}));

mock.module('../../src/services/context/sections/FooterRenderer.js', () => ({
  renderPreviouslySection: () => previouslyLines,
  renderFooter: () => footerLines,
}));

mock.module('../../src/services/context/formatters/AgentFormatter.js', () => ({
  renderAgentEmptyState: (project: string) => `agent-empty:${project}`,
}));

mock.module('../../src/services/context/formatters/HumanFormatter.js', () => ({
  renderHumanEmptyState: (project: string) => `human-empty:${project}`,
}));

const contextBuilderModulePromise = import('../../src/services/context/ContextBuilder.js');

beforeEach(() => {
  defaultConfig = {
    totalObservationCount: 12,
    sessionCount: 3,
    fullObservationCount: 2,
  };
  observations = [{ id: 'obs-1' }];
  summaries = [{ id: 'summary-1' }];
  headerLines = ['Header'];
  timelineLines = ['Timeline'];
  summaryLines = [];
  previouslyLines = ['Previously'];
  footerLines = ['Footer'];
  capturedConfigs = [];
});

describe('ContextBuilder patches', () => {
  it('caps full-mode observation and session counts before querying data', async () => {
    const { generateContext } = await contextBuilderModulePromise;

    await generateContext({ cwd: '/tmp/project', full: true });

    expect(capturedConfigs.length).toBeGreaterThan(0);
    expect(capturedConfigs.every((config) => config.totalObservationCount === 500)).toBe(true);
    expect(capturedConfigs.every((config) => config.sessionCount === 50)).toBe(true);
  });

  it('preserves configured counts when full mode is disabled', async () => {
    const { generateContext } = await contextBuilderModulePromise;

    await generateContext({ cwd: '/tmp/project' });

    expect(capturedConfigs.length).toBeGreaterThan(0);
    expect(capturedConfigs.every((config) => config.totalObservationCount === 12)).toBe(true);
    expect(capturedConfigs.every((config) => config.sessionCount === 3)).toBe(true);
  });

  it('truncates oversized rendered output with a guard marker', async () => {
    const { generateContext } = await contextBuilderModulePromise;
    summaryLines = ['x'.repeat(500_200)];

    const output = await generateContext({ cwd: '/tmp/project' });

    expect(output).toContain('[context truncated');
    expect(output.startsWith('Header\nTimeline')).toBe(true);
    expect(output.length).toBeLessThan(500_200);
  });
});
