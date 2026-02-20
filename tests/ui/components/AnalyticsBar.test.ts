/**
 * Structural tests for AnalyticsBar component
 *
 * Tests module structure and CSS class references since vitest runs without jsdom.
 * No DOM rendering is performed. Label assertions use JSX text content patterns
 * (e.g., >Read<) rather than bare substring matching to avoid false positives.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const COMPONENT_PATH = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/AnalyticsBar.tsx'
);

let source: string;

beforeAll(() => {
  source = fs.readFileSync(COMPONENT_PATH, 'utf8');
});

describe('AnalyticsBar component module', () => {
  it('exports AnalyticsBar component', async () => {
    const mod = await import('../../../src/ui/viewer/components/AnalyticsBar');
    // React.memo wraps the function, so typeof is 'object' with $$typeof Symbol
    expect(mod.AnalyticsBar).toBeDefined();
    expect(typeof mod.AnalyticsBar).toBe('object');
  });
});

describe('AnalyticsBar component source', () => {
  it('contains analytics-bar CSS class', () => {
    expect(source).toContain('analytics-bar');
  });

  it('contains analytics-card CSS class', () => {
    expect(source).toContain('analytics-card');
  });

  it('contains analytics-card__label CSS class', () => {
    expect(source).toContain('analytics-card__label');
  });

  it('contains analytics-card__value CSS class', () => {
    expect(source).toContain('analytics-card__value');
  });

  it('contains analytics-card__subtitle CSS class', () => {
    expect(source).toContain('analytics-card__subtitle');
  });

  it('contains analytics-time-range CSS class', () => {
    expect(source).toContain('analytics-time-range');
  });

  it('contains analytics-time-range__btn CSS class', () => {
    expect(source).toContain('analytics-time-range__btn');
  });

  it('contains analytics-time-range__btn--active CSS class', () => {
    expect(source).toContain('analytics-time-range__btn--active');
  });

  it('contains analytics-card--purple CSS class', () => {
    expect(source).toContain('analytics-card--purple');
  });

  it('contains analytics-card--green CSS class', () => {
    expect(source).toContain('analytics-card--green');
  });

  it('uses useAnalytics hook', () => {
    expect(source).toContain('useAnalytics');
  });

  it('uses formatTokenCount utility', () => {
    expect(source).toContain('formatTokenCount');
  });

  it('renders Read label in JSX', () => {
    expect(source).toMatch(/>Read</);
  });

  it('renders Work label in JSX', () => {
    expect(source).toMatch(/>Work</);
  });

  it('renders Recalled label in JSX', () => {
    expect(source).toMatch(/>Recalled</);
  });

  it('renders Saved label in JSX', () => {
    expect(source).toMatch(/>Saved</);
  });

  it('renders Obs label in JSX', () => {
    expect(source).toMatch(/>Obs</);
  });

  it('contains analytics-card--muted CSS class for zero savings', () => {
    expect(source).toContain('analytics-card--muted');
  });

  it('contains analytics-card--accent CSS class', () => {
    expect(source).toContain('analytics-card--accent');
  });

  it('renders time range buttons: 7d, 30d, 90d, All', () => {
    expect(source).toContain("'7d'");
    expect(source).toContain("'30d'");
    expect(source).toContain("'90d'");
    expect(source).toContain("'All'");
  });
});

describe('AnalyticsBar accessibility', () => {
  it('uses React.memo for render optimization', () => {
    expect(source).toMatch(/React\.memo/);
  });

  it('has role="region" on container', () => {
    expect(source).toContain('role="region"');
  });

  it('has aria-label="Token analytics" on container', () => {
    expect(source).toContain('aria-label="Token analytics"');
  });

  it('has role="group" on time range', () => {
    expect(source).toContain('role="group"');
  });

  it('has aria-label="Time range" on group', () => {
    expect(source).toContain('aria-label="Time range"');
  });

  it('has aria-pressed on time range buttons', () => {
    expect(source).toContain('aria-pressed');
  });

  it('has aria-busy on cards container', () => {
    expect(source).toContain('aria-busy');
  });

  it('has title attributes on abbreviated labels', () => {
    expect(source).toContain('title="Observations"');
    expect(source).toContain('title="sessions"');
    expect(source).toContain('title="Read tokens"');
    expect(source).toContain('title="Work tokens"');
    expect(source).toContain('title="Recalled tokens"');
    expect(source).toContain('title="Saved tokens"');
  });

  it('has role="status" on skeleton loading elements', () => {
    expect(source).toContain('role="status"');
  });

  it('has differentiated aria-labels on skeleton elements', () => {
    expect(source).toContain('aria-label="Loading read tokens"');
    expect(source).toContain('aria-label="Loading work tokens"');
    expect(source).toContain('aria-label="Loading recalled tokens"');
    expect(source).toContain('aria-label="Loading saved tokens"');
    expect(source).toContain('aria-label="Loading observations"');
  });

  it('has tabIndex on cards for keyboard accessibility', () => {
    expect(source).toContain('tabIndex={0}');
  });
});

describe('AnalyticsBar tooltips', () => {
  it('contains TOOLTIPS constant with descriptions', () => {
    expect(source).toContain('TOOLTIPS');
  });

  it('contains analytics-tooltip CSS class', () => {
    expect(source).toContain('analytics-tooltip');
  });

  it('has role="tooltip" on tooltip elements', () => {
    expect(source).toContain('role="tooltip"');
  });

  it('has tooltip text for read metric', () => {
    expect(source).toContain('Tokens spent reading observations back into context');
  });

  it('has tooltip text for work metric', () => {
    expect(source).toContain('AI tokens invested in research, building, and decisions');
  });

  it('has tooltip text for recalled metric', () => {
    expect(source).toContain('Tokens recalled from stored memories into sessions');
  });

  it('has tooltip text for saved metric', () => {
    expect(source).toContain('Net tokens saved by reusing compressed context');
  });

  it('has tooltip text for obs metric', () => {
    expect(source).toContain('Observations recorded / distinct Claude sessions');
  });

  it('renders tooltip spans always in DOM (CSS controls visibility)', () => {
    // Tooltips are always rendered (not conditional on state), CSS :hover/:focus shows them
    const tooltipMatches = source.match(/className="analytics-tooltip"/g);
    expect(tooltipMatches).not.toBeNull();
    expect(tooltipMatches!.length).toBe(5);
  });
});

describe('AnalyticsBar subtitle loading gate', () => {
  it('gates subtitle rendering on !isLoading', () => {
    expect(source).toContain('!isLoading');
  });
});
