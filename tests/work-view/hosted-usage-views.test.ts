import { describe, expect, it } from 'bun:test';
import { HOSTED_USAGE_VIEWS, hostedUsageEvent } from '../../services/viewer-host/src/usage';
import { WORK_VIEW_USAGE_VIEWS } from '../../src/shared/work-view-pages';

/**
 * The hosted viewer (services/viewer-host, its own image without src/shared) types My Work's usage views again. Both
 * programs must agree: a view only the page knows was dropped without a word by the hosted gate (hostedUsageEvent
 * answered null), which is how Focus areas, Requests and Review Stack went uncounted on work.cmem.ai.
 */
describe('hosted usage views', () => {
  it('are exactly the views My Work counts', () => {
    expect([...HOSTED_USAGE_VIEWS].sort()).toEqual([...WORK_VIEW_USAGE_VIEWS].sort());
  });

  it('each view My Work counts reaches PostHog through the hosted gate', () => {
    for (const view of WORK_VIEW_USAGE_VIEWS) {
      expect({ view, event: hostedUsageEvent({ event: 'opened', view }, 'work.cmem.ai', 'https://work.cmem.ai/')?.event }).toEqual({ view, event: 'work_view_opened' });
    }
  });
});
