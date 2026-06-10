import { afterAll, describe, expect, it, mock } from 'bun:test';

import * as realSessionStoreNs from '../../src/services/sqlite/SessionStore.js';
import * as realProjectNameNs from '../../src/utils/project-name.js';
import * as realContextConfigLoaderNs from '../../src/services/context/ContextConfigLoader.js';
import * as realTokenCalculatorNs from '../../src/services/context/TokenCalculator.js';
import * as realObservationCompilerNs from '../../src/services/context/ObservationCompiler.js';
import * as realHeaderRendererNs from '../../src/services/context/sections/HeaderRenderer.js';
import * as realTimelineRendererNs from '../../src/services/context/sections/TimelineRenderer.js';
import * as realSummaryRendererNs from '../../src/services/context/sections/SummaryRenderer.js';
import * as realFooterRendererNs from '../../src/services/context/sections/FooterRenderer.js';
import * as realAgentFormatterNs from '../../src/services/context/formatters/AgentFormatter.js';
import * as realHumanFormatterNs from '../../src/services/context/formatters/HumanFormatter.js';

const queryObservationsCalls: string[] = [];
const realSessionStore = { ...realSessionStoreNs };
const realProjectName = { ...realProjectNameNs };
const realContextConfigLoader = { ...realContextConfigLoaderNs };
const realTokenCalculator = { ...realTokenCalculatorNs };
const realObservationCompiler = { ...realObservationCompilerNs };
const realHeaderRenderer = { ...realHeaderRendererNs };
const realTimelineRenderer = { ...realTimelineRendererNs };
const realSummaryRenderer = { ...realSummaryRendererNs };
const realFooterRenderer = { ...realFooterRendererNs };
const realAgentFormatter = { ...realAgentFormatterNs };
const realHumanFormatter = { ...realHumanFormatterNs };

mock.module('../../src/services/sqlite/SessionStore.js', () => ({
  SessionStore: class {
    close(): void {}
  },
}));

mock.module('../../src/utils/project-name.js', () => ({
  getProjectContext: () => ({
    primary: 'fallback-project',
    allProjects: ['fallback-project:dream', 'fallback-project'],
  }),
}));

mock.module('../../src/services/context/ContextConfigLoader.js', () => ({
  loadContextConfig: () => ({
    totalObservationCount: 5,
    sessionCount: 5,
    fullObservationCount: 5,
  }),
}));

mock.module('../../src/services/context/TokenCalculator.js', () => ({
  calculateTokenEconomics: () => ({
    totalReadTokens: 0,
    savings: 0,
  }),
}));

mock.module('../../src/services/context/ObservationCompiler.js', () => ({
  countObservationsByProjects: () => 1,
  countSummariesByProjects: () => 0,
  queryObservations: (_db: unknown, project: string) => {
    queryObservationsCalls.push(project);
    return [];
  },
  queryObservationsMulti: () => [],
  querySummaries: () => [],
  querySummariesMulti: () => [],
  getPriorSessionMessages: () => [],
  prepareSummariesForTimeline: () => [],
  buildTimeline: () => [],
  getFullObservationIds: () => new Set<number>(),
}));

mock.module('../../src/services/context/sections/HeaderRenderer.js', () => ({
  renderHeader: () => [],
}));

mock.module('../../src/services/context/sections/TimelineRenderer.js', () => ({
  renderTimeline: () => [],
}));

mock.module('../../src/services/context/sections/SummaryRenderer.js', () => ({
  shouldShowSummary: () => false,
  renderSummaryFields: () => [],
}));

mock.module('../../src/services/context/sections/FooterRenderer.js', () => ({
  renderPreviouslySection: () => [],
  renderFooter: () => [],
}));

mock.module('../../src/services/context/formatters/AgentFormatter.js', () => ({
  renderAgentEmptyState: (project: string) => `empty:${project}`,
}));

mock.module('../../src/services/context/formatters/HumanFormatter.js', () => ({
  renderHumanEmptyState: (project: string) => `human-empty:${project}`,
}));

import {
  generateContextWithStats,
  getPrimaryContextProject,
} from '../../src/services/context/ContextBuilder.js';

describe('getPrimaryContextProject', () => {
  afterAll(() => {
    mock.module('../../src/services/sqlite/SessionStore.js', () => realSessionStore);
    mock.module('../../src/utils/project-name.js', () => realProjectName);
    mock.module('../../src/services/context/ContextConfigLoader.js', () => realContextConfigLoader);
    mock.module('../../src/services/context/TokenCalculator.js', () => realTokenCalculator);
    mock.module('../../src/services/context/ObservationCompiler.js', () => realObservationCompiler);
    mock.module('../../src/services/context/sections/HeaderRenderer.js', () => realHeaderRenderer);
    mock.module('../../src/services/context/sections/TimelineRenderer.js', () => realTimelineRenderer);
    mock.module('../../src/services/context/sections/SummaryRenderer.js', () => realSummaryRenderer);
    mock.module('../../src/services/context/sections/FooterRenderer.js', () => realFooterRenderer);
    mock.module('../../src/services/context/formatters/AgentFormatter.js', () => realAgentFormatter);
    mock.module('../../src/services/context/formatters/HumanFormatter.js', () => realHumanFormatter);
  });

  it('prefers the last raw project when dream and raw namespaces are interleaved', () => {
    expect(
      getPrimaryContextProject(
        ['project-a', 'project-a:dream', 'project-b:dream', 'project-b'],
        'fallback-project'
      )
    ).toBe('project-b');
  });

  it('falls back to the context primary project when only dream namespaces are supplied', () => {
    expect(
      getPrimaryContextProject(
        ['project-a:dream', 'project-b:dream'],
        'fallback-project'
      )
    ).toBe('fallback-project');
  });

  it('queries the dream namespace directly when it is the only effective project', async () => {
    queryObservationsCalls.length = 0;

    const result = await generateContextWithStats({
      cwd: '/tmp/project',
      projects: ['project-a:dream'],
    });

    expect(queryObservationsCalls).toEqual(['project-a:dream']);
    expect(result.text).toBe('empty:fallback-project');
  });
});
