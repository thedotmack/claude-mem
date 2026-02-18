/**
 * Tests for task notification detection, TaskNotificationCard component,
 * and routing logic in SessionDetail/Feed.
 *
 * Testing approach mirrors the established project pattern:
 * - Pure functions are tested directly
 * - Component structure is verified via source-code inspection (no DOM renderer)
 * - React.createElement smoke tests for component contract
 *
 * TDD: These tests are written BEFORE implementation (RED phase).
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';
import type { UserPrompt } from '../../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePrompt(overrides: Partial<UserPrompt> = {}): UserPrompt {
  return {
    id: 1,
    content_session_id: 'session-abc',
    project: 'test-project',
    prompt_number: 1,
    prompt_text: 'Regular prompt text',
    created_at_epoch: 1700000000000,
    ...overrides,
  };
}

const TASK_NOTIFICATION_TEXT = `<task-notification>
  <task-id>abc123</task-id>
  <status>completed</status>
  <summary>Task finished successfully</summary>
  <result>Detailed result text here...</result>
</task-notification>`;

// ---------------------------------------------------------------------------
// isTaskNotification — pure function tests
// ---------------------------------------------------------------------------

describe('isTaskNotification', () => {
  it('returns true for prompt starting with <task-notification>', async () => {
    const { isTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const prompt = makePrompt({ prompt_text: TASK_NOTIFICATION_TEXT });
    expect(isTaskNotification(prompt)).toBe(true);
  });

  it('returns true with leading whitespace before <task-notification>', async () => {
    const { isTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const prompt = makePrompt({
      prompt_text: '   \n  <task-notification>\n  <task-id>x</task-id>\n</task-notification>',
    });
    expect(isTaskNotification(prompt)).toBe(true);
  });

  it('returns false for regular prompt text', async () => {
    const { isTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const prompt = makePrompt({ prompt_text: 'Please help me fix the bug in auth.ts' });
    expect(isTaskNotification(prompt)).toBe(false);
  });

  it('returns false for empty string', async () => {
    const { isTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const prompt = makePrompt({ prompt_text: '' });
    expect(isTaskNotification(prompt)).toBe(false);
  });

  it('returns false for prompt that contains <task-notification> but not at the start', async () => {
    const { isTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const prompt = makePrompt({
      prompt_text: 'Some preamble text\n<task-notification>...</task-notification>',
    });
    expect(isTaskNotification(prompt)).toBe(false);
  });

  it('returns false for prompt that looks similar but does not match exactly', async () => {
    const { isTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const prompt = makePrompt({ prompt_text: '<task-notify>not the right tag</task-notify>' });
    expect(isTaskNotification(prompt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTaskNotification — pure helper for extracting fields via regex
// ---------------------------------------------------------------------------

describe('parseTaskNotification', () => {
  it('extracts task-id from well-formed content', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification(TASK_NOTIFICATION_TEXT);
    expect(result.taskId).toBe('abc123');
  });

  it('extracts status from well-formed content', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification(TASK_NOTIFICATION_TEXT);
    expect(result.status).toBe('completed');
  });

  it('extracts summary from well-formed content', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification(TASK_NOTIFICATION_TEXT);
    expect(result.summary).toBe('Task finished successfully');
  });

  it('extracts result from well-formed content', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification(TASK_NOTIFICATION_TEXT);
    expect(result.result).toBe('Detailed result text here...');
  });

  it('returns null for task-id when tag is missing', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification('<task-notification><status>done</status></task-notification>');
    expect(result.taskId).toBeNull();
  });

  it('returns null for status when tag is missing', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification('<task-notification><task-id>x</task-id></task-notification>');
    expect(result.status).toBeNull();
  });

  it('returns null for result when tag is missing', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const result = parseTaskNotification('<task-notification><task-id>x</task-id></task-notification>');
    expect(result.result).toBeNull();
  });

  it('handles multiline result content', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    const multiline = `<task-notification>
  <task-id>xyz</task-id>
  <status>in_progress</status>
  <summary>Working on it</summary>
  <result>Line 1
Line 2
Line 3</result>
</task-notification>`;
    const result = parseTaskNotification(multiline);
    expect(result.result).toContain('Line 1');
    expect(result.result).toContain('Line 3');
  });

  it('does not throw on empty string', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    expect(() => parseTaskNotification('')).not.toThrow();
  });

  it('does not throw on malformed XML-like content', async () => {
    const { parseTaskNotification } = await import(
      '../../../src/ui/viewer/utils/taskNotification.js'
    );
    expect(() => parseTaskNotification('<task-notification><unclosed')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TaskNotificationCard — module smoke tests
// ---------------------------------------------------------------------------

describe('TaskNotificationCard module', () => {
  it('exports TaskNotificationCard as a named function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    expect(typeof mod.TaskNotificationCard).toBe('function');
  });

  it('does not throw on import', async () => {
    await expect(
      import('../../../src/ui/viewer/components/TaskNotificationCard.js'),
    ).resolves.toBeDefined();
  });

  it('component can be used as a React element type', async () => {
    const { TaskNotificationCard } = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const React = await import('react');
    const prompt = makePrompt({ prompt_text: TASK_NOTIFICATION_TEXT });
    const element = React.createElement(TaskNotificationCard, { prompt });
    expect(element).toBeDefined();
    expect(element.type).toBe(TaskNotificationCard);
  });
});

// ---------------------------------------------------------------------------
// TaskNotificationCard — structure via source-code inspection
// ---------------------------------------------------------------------------

describe('TaskNotificationCard renders TASK type badge', () => {
  it('component source renders a TASK type badge element', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('task-notification-card__type-badge');
    expect(fnSource).toContain('TASK');
  });
});

describe('TaskNotificationCard renders task-id', () => {
  it('component source references taskId in its output', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('taskId');
  });
});

describe('TaskNotificationCard renders status', () => {
  it('component source references status in its output', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('status');
  });
});

describe('TaskNotificationCard renders summary', () => {
  it('component source references summary in its output', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('summary');
  });
});

describe('TaskNotificationCard is collapsed by default', () => {
  it('component source uses useState with false as initial expanded state', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    // useState(false) for collapsed default
    expect(fnSource).toContain('useState');
    expect(fnSource).toContain('false');
  });

  it('result section is conditionally rendered (behind expanded state)', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    // The result content must be behind a conditional — expanded state variable
    expect(fnSource).toContain('expanded');
    expect(fnSource).toContain('result');
  });
});

describe('TaskNotificationCard expands on click to show result', () => {
  it('component source has a click/toggle handler that flips expanded state', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('setExpanded');
  });
});

describe('TaskNotificationCard has amber/orange accent styling class', () => {
  it('root element has task-notification-card class', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('task-notification-card');
  });

  it('root element has data-testid="task-notification-card"', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const fnSource = mod.TaskNotificationCard.toString();
    expect(fnSource).toContain('task-notification-card');
    expect(fnSource).toContain('data-testid');
  });
});

describe('TaskNotificationCard handles malformed content gracefully', () => {
  it('component can receive a prompt with raw/malformed text without crashing (createElement check)', async () => {
    const { TaskNotificationCard } = await import(
      '../../../src/ui/viewer/components/TaskNotificationCard.js'
    );
    const React = await import('react');
    const prompt = makePrompt({ prompt_text: '<task-notification><unclosed' });
    const element = React.createElement(TaskNotificationCard, { prompt });
    expect(element).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PromptCard — PROMPT type badge tests (updated component)
// ---------------------------------------------------------------------------

describe('PromptCard renders PROMPT type badge', () => {
  it('component source renders a PROMPT type badge element', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/PromptCard.js'
    );
    const fnSource = mod.PromptCard.toString();
    expect(fnSource).toContain('prompt-card__type-badge');
    expect(fnSource).toContain('PROMPT');
  });
});

// ---------------------------------------------------------------------------
// ObservationCard — type badge tests (updated component)
// ---------------------------------------------------------------------------

describe('ObservationCard renders type badge with observation type', () => {
  it('component source renders a type badge element using observation type', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/ObservationCard.js'
    );
    const fnSource = mod.ObservationCard.toString();
    expect(fnSource).toContain('observation-card__type-badge');
  });

  it('type badge references observation.type field', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/ObservationCard.js'
    );
    const fnSource = mod.ObservationCard.toString();
    // The badge should display the observation type
    expect(fnSource).toContain('observation.type');
  });
});

// ---------------------------------------------------------------------------
// Routing: SessionDetail — renders TaskNotificationCard for task prompts
// ---------------------------------------------------------------------------

describe('SessionDetail routing — task notification prompts', () => {
  it('SessionDetail source imports TaskNotificationCard', async () => {
    const source = readFileSync(
      new URL(
        '../../../src/ui/viewer/components/SessionDetail.tsx',
        import.meta.url,
      ).pathname,
      'utf8',
    );
    expect(source).toContain('TaskNotificationCard');
  });

  it('SessionDetail source imports isTaskNotification', async () => {
    const source = readFileSync(
      new URL(
        '../../../src/ui/viewer/components/SessionDetail.tsx',
        import.meta.url,
      ).pathname,
      'utf8',
    );
    expect(source).toContain('isTaskNotification');
  });

  it('SessionDetail source uses isTaskNotification in rendering logic', async () => {
    const source = readFileSync(
      new URL(
        '../../../src/ui/viewer/components/SessionDetail.tsx',
        import.meta.url,
      ).pathname,
      'utf8',
    );
    // The routing check must appear in the render helper
    expect(source).toContain('isTaskNotification');
    expect(source).toContain('TaskNotificationCard');
  });
});

// ---------------------------------------------------------------------------
// Routing: Feed — renders TaskNotificationCard for task prompts
// ---------------------------------------------------------------------------

describe('Feed routing — task notification prompts', () => {
  it('Feed source imports TaskNotificationCard', async () => {
    const source = readFileSync(
      new URL(
        '../../../src/ui/viewer/components/Feed.tsx',
        import.meta.url,
      ).pathname,
      'utf8',
    );
    expect(source).toContain('TaskNotificationCard');
  });

  it('Feed source imports isTaskNotification', async () => {
    const source = readFileSync(
      new URL(
        '../../../src/ui/viewer/components/Feed.tsx',
        import.meta.url,
      ).pathname,
      'utf8',
    );
    expect(source).toContain('isTaskNotification');
  });

  it('Feed source uses isTaskNotification when rendering prompt items', async () => {
    const source = readFileSync(
      new URL(
        '../../../src/ui/viewer/components/Feed.tsx',
        import.meta.url,
      ).pathname,
      'utf8',
    );
    expect(source).toContain('isTaskNotification');
    expect(source).toContain('TaskNotificationCard');
  });
});

// ---------------------------------------------------------------------------
// CSS: viewer-template.html — new card style classes
// ---------------------------------------------------------------------------

describe('CSS: task-notification-card styles in viewer-template.html', () => {
  const templateSource = readFileSync(
    new URL(
      '../../../src/ui/viewer-template.html',
      import.meta.url,
    ).pathname,
    'utf8',
  );

  it('defines .task-notification-card CSS class', () => {
    expect(templateSource).toContain('.task-notification-card');
  });

  it('defines .task-notification-card__type-badge CSS class', () => {
    expect(templateSource).toContain('.task-notification-card__type-badge');
  });

  it('defines .prompt-card__type-badge CSS class', () => {
    expect(templateSource).toContain('.prompt-card__type-badge');
  });

  it('defines .observation-card__type-badge CSS class', () => {
    expect(templateSource).toContain('.observation-card__type-badge');
  });
});
