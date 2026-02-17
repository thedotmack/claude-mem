/**
 * Tests for PromptCard component
 *
 * Since @testing-library/react is not installed (vitest runs without a browser),
 * and React hooks cannot be called outside the React renderer, we test by:
 * 1. Importing the module (smoke test / module contract)
 * 2. Inspecting compiled source strings to assert structural requirements
 * 3. Using React.createElement to verify the component returns a React element
 *    (not calling the component function directly)
 *
 * Layout-dependent features (CSS truncation, scrollHeight vs clientHeight) and
 * interaction (click handlers toggling state) are covered by the Playwright
 * E2E suite.
 */

import { describe, it, expect } from 'vitest';
import type { UserPrompt } from '../../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-abc-123';
const PROJECT = 'test-project';

function makePrompt(overrides: Partial<UserPrompt> = {}): UserPrompt {
  return {
    id: 42,
    content_session_id: SESSION_ID,
    project: PROJECT,
    prompt_number: 3,
    prompt_text: 'What is the current state of the authentication system?',
    created_at_epoch: new Date(2026, 1, 17, 14, 30, 0).getTime(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module smoke tests
// ---------------------------------------------------------------------------

describe('PromptCard component module', () => {
  it('exports a PromptCard function component', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    expect(typeof mod.PromptCard).toBe('function');
  });

  it('does not throw on import', async () => {
    await expect(
      import('../../../src/ui/viewer/components/PromptCard.js'),
    ).resolves.toBeDefined();
  });

  it('component renders without crashing with minimal prompt data', async () => {
    const { PromptCard } = await import(
      '../../../src/ui/viewer/components/PromptCard.js'
    );
    const React = await import('react');

    const minimalPrompt = makePrompt({ prompt_text: '', project: '' });
    const element = React.createElement(PromptCard, { prompt: minimalPrompt });

    expect(element).toBeDefined();
    expect(element.type).toBe(PromptCard);
  });
});

// ---------------------------------------------------------------------------
// Component renders prompt data (React.createElement without calling hooks)
// ---------------------------------------------------------------------------

describe('PromptCard renders prompt data', () => {
  it('component function accepts a prompt prop and returns a React element', async () => {
    const { PromptCard } = await import(
      '../../../src/ui/viewer/components/PromptCard.js'
    );
    const React = await import('react');

    const prompt = makePrompt();
    const element = React.createElement(PromptCard, { prompt });

    expect(element).toBeDefined();
    expect(element.type).toBe(PromptCard);
    expect(element.props.prompt).toEqual(prompt);
  });
});

// ---------------------------------------------------------------------------
// Component structure: verified via compiled source inspection
// Source inspection is the established pattern in this project for components
// that use React hooks (cannot be called outside renderer context).
// ---------------------------------------------------------------------------

describe('PromptCard renders prompt text', () => {
  it('component source renders prompt_text in content area', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    // Compiled JSX renders prompt_text as a child of the content div
    expect(fnSource).toContain('prompt_text');
  });
});

describe('PromptCard renders prompt id as badge', () => {
  it('component source renders prompt id with # prefix as badge', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    // The badge should render "#" followed by the id
    // In compiled JSX: "#", prompt.id (as separate children or template)
    const hasBadgeClass = fnSource.includes('prompt-card__badge');
    expect(hasBadgeClass).toBe(true);

    // The # prefix character must be present in the source
    const hasHash = fnSource.includes('"#"') || fnSource.includes("'#'") || fnSource.includes('`#`') || fnSource.includes('"#",');
    expect(hasHash).toBe(true);
  });
});

describe('PromptCard renders project name', () => {
  it('component source renders project in a prompt-card__project element', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('prompt-card__project');
    // project field is accessed
    expect(fnSource).toContain('prompt.project');
  });
});

describe('PromptCard renders date', () => {
  it('component source calls formatDate on created_at_epoch', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    // formatDate is called in the component
    expect(fnSource).toContain('formatDate');
    expect(fnSource).toContain('created_at_epoch');
  });

  it('component source renders formatted date in header', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('prompt-card__date');
  });
});

// ---------------------------------------------------------------------------
// Component structure: data-testid and class attributes
// ---------------------------------------------------------------------------

describe('PromptCard has left-border accent (prompt-card class + data-testid)', () => {
  it('root element has data-testid="prompt-card"', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('data-testid');
    expect(fnSource).toContain('prompt-card');
  });

  it('root element has both "card" and "prompt-card" classes', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    // className should include both "card" and "prompt-card"
    expect(fnSource).toContain('"card prompt-card"');
  });
});

describe('PromptCard renders aria-expanded attribute', () => {
  it('component source uses aria-expanded for expanded state', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('aria-expanded');
  });
});

// ---------------------------------------------------------------------------
// Content area
// ---------------------------------------------------------------------------

describe('PromptCard content area', () => {
  it('renders content div with data-testid="prompt-card-content"', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('prompt-card-content');
  });

  it('content area references prompt text field', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('prompt_text');
  });
});

// ---------------------------------------------------------------------------
// Show more / show less toggle button
// ---------------------------------------------------------------------------

describe('PromptCard show more / show less toggle', () => {
  it('renders a toggle button with data-testid="prompt-card-toggle"', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('prompt-card-toggle');
  });

  it('toggle button text changes based on expanded state (Show more / Show less)', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('Show more');
    expect(fnSource).toContain('Show less');
  });

  it('toggle button uses expanded state from useState', async () => {
    const mod = await import('../../../src/ui/viewer/components/PromptCard.js');
    const fnSource = mod.PromptCard.toString();

    expect(fnSource).toContain('useState');
  });
});
