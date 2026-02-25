/**
 * Tests for Header component
 *
 * Since @testing-library/react is not installed, we test via module inspection:
 * 1. Component exports can be imported
 * 2. Props interface no longer includes themePreference / onThemeChange (structural)
 * 3. Component source does not reference ThemeToggle, docs link, or GitHubStarsButton
 *
 * Visual / interaction behaviour is covered by the Playwright E2E suite.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HEADER_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/Header.tsx'
);

const TEMPLATE_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer-template.html'
);

let headerSource: string;
let templateSource: string;

beforeAll(() => {
  headerSource = fs.readFileSync(HEADER_SRC, 'utf-8');
  templateSource = fs.readFileSync(TEMPLATE_SRC, 'utf-8');
});

// ---------------------------------------------------------------------------
// Removed elements — these must NOT appear in the header
// ---------------------------------------------------------------------------

describe('Header does NOT render ThemeToggle', () => {
  it('does not import ThemeToggle', () => {
    expect(headerSource).not.toMatch(/import.*ThemeToggle/);
  });

  it('does not use <ThemeToggle', () => {
    expect(headerSource).not.toMatch(/<ThemeToggle/);
  });

  it('does not accept themePreference prop', () => {
    expect(headerSource).not.toMatch(/themePreference\s*:/);
  });

  it('does not accept onThemeChange prop', () => {
    expect(headerSource).not.toMatch(/onThemeChange\s*:/);
  });
});

describe('Header does NOT render a docs link', () => {
  it('does not contain a link to docs.magic-claude-mem.ai', () => {
    expect(headerSource).not.toMatch(/docs\.magic-claude-mem\.ai/);
  });

  it('does not render an icon-link anchor tag', () => {
    expect(headerSource).not.toMatch(/className="icon-link"/);
  });
});

describe('Header does NOT render GitHubStarsButton', () => {
  it('does not import GitHubStarsButton', () => {
    expect(headerSource).not.toMatch(/import.*GitHubStarsButton/);
  });

  it('does not use <GitHubStarsButton', () => {
    expect(headerSource).not.toMatch(/<GitHubStarsButton/);
  });
});

// ---------------------------------------------------------------------------
// Required elements — these MUST appear in the header
// ---------------------------------------------------------------------------

describe('Header renders SearchBar', () => {
  it('imports SearchBar', () => {
    expect(headerSource).toMatch(/import.*SearchBar/);
  });

  it('renders <SearchBar', () => {
    expect(headerSource).toMatch(/<SearchBar/);
  });
});

describe('Header renders project selector via ProjectDropdown', () => {
  it('imports ProjectDropdown', () => {
    expect(headerSource).toMatch(/import.*ProjectDropdown/);
  });

  it('renders <ProjectDropdown instead of <select', () => {
    expect(headerSource).toMatch(/<ProjectDropdown/);
    expect(headerSource).not.toMatch(/<select/);
  });

  it('passes onProjectsChanged prop to ProjectDropdown', () => {
    expect(headerSource).toContain('onProjectsChanged');
  });

  it('does not render a native <select> for project filtering', () => {
    expect(headerSource).not.toMatch(/<select/);
  });
});

describe('Header renders settings button', () => {
  it('renders an element with class settings-btn', () => {
    expect(headerSource).toMatch(/settings-btn/);
  });

  it('calls onContextPreviewToggle when settings button is clicked', () => {
    expect(headerSource).toMatch(/onContextPreviewToggle/);
  });
});

describe('Header renders filter toggle button', () => {
  it('renders an element with class filter-toggle-btn', () => {
    expect(headerSource).toMatch(/filter-toggle-btn/);
  });

  it('calls onFilterToggle prop when clicked', () => {
    expect(headerSource).toMatch(/onFilterToggle/);
  });

  it('does NOT manage filterBarOpen state internally', () => {
    expect(headerSource).not.toMatch(/filterBarOpen/);
  });
});

describe('Header does NOT render FilterBar', () => {
  it('does not import FilterBar', () => {
    expect(headerSource).not.toMatch(/import.*FilterBar/);
  });

  it('does not render <FilterBar', () => {
    expect(headerSource).not.toMatch(/<FilterBar/);
  });

  it('does not accept filter-related props (filters, onToggleObsType, etc)', () => {
    expect(headerSource).not.toMatch(/onToggleObsType\s*[,:]/);
    expect(headerSource).not.toMatch(/onToggleConcept\s*[,:]/);
    expect(headerSource).not.toMatch(/onToggleItemKind\s*[,:]/);
    expect(headerSource).not.toMatch(/onDateRangeChange\s*[,:]/);
    expect(headerSource).not.toMatch(/onClearAllFilters\s*[,:]/);
  });
});

describe('Header renders logo', () => {
  it('renders the logomark image', () => {
    expect(headerSource).toMatch(/logomark/);
  });

  it('renders magic-claude-mem text', () => {
    expect(headerSource).toMatch(/magic-claude-mem/);
  });

  it('renders logo-text span', () => {
    expect(headerSource).toMatch(/logo-text/);
  });
});

// ---------------------------------------------------------------------------
// AnalyticsBar integration
// ---------------------------------------------------------------------------

describe('Header renders AnalyticsBar inline', () => {
  it('imports AnalyticsBar', () => {
    expect(headerSource).toMatch(/import.*AnalyticsBar/);
  });

  it('renders <AnalyticsBar', () => {
    expect(headerSource).toMatch(/<AnalyticsBar/);
  });

  it('accepts project prop', () => {
    expect(headerSource).toMatch(/project\s*:\s*string/);
  });

  it('places AnalyticsBar between h1 and status div', () => {
    const h1Close = headerSource.indexOf('</h1>');
    const analyticsIdx = headerSource.indexOf('<AnalyticsBar');
    const statusIdx = headerSource.indexOf('className="status"');
    expect(h1Close).toBeGreaterThanOrEqual(0);
    expect(analyticsIdx).toBeGreaterThan(h1Close);
    expect(statusIdx).toBeGreaterThan(analyticsIdx);
  });

  it('does not shadow project variable in .map() callback', () => {
    // The .map() callback should NOT use `project` as its parameter name
    // since it would shadow the component's `project` prop
    expect(headerSource).not.toMatch(/\.map\(\s*project\s*=>/);
    expect(headerSource).not.toMatch(/\.map\(\(\s*project\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// Component module smoke test
// ---------------------------------------------------------------------------

describe('Header component module', () => {
  it('exports a Header function', async () => {
    const mod = await import('../../../src/ui/viewer/components/Header.js');
    expect(typeof mod.Header).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// queue-bubble rendering — conditional on queueDepth
// ---------------------------------------------------------------------------

describe('Header queue-bubble — JSX structure', () => {
  it('renders queue-bubble div when queueDepth > 0', () => {
    expect(headerSource).toMatch(/queueDepth\s*>\s*0/);
  });

  it('renders queue-bubble div with class "queue-bubble"', () => {
    expect(headerSource).toMatch(/className="queue-bubble"/);
  });

  it('displays the queueDepth value inside the bubble', () => {
    expect(headerSource).toMatch(/\{queueDepth\}/);
  });

  it('does NOT render queue-bubble unconditionally', () => {
    expect(headerSource).toMatch(/queueDepth\s*>\s*0/);
    const matches = headerSource.match(/className="queue-bubble"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('accepts queueDepth as a prop in the interface', () => {
    expect(headerSource).toMatch(/queueDepth\s*:/);
  });

  it('places queue-bubble inside header__logo-wrapper', () => {
    expect(headerSource).toMatch(/header__logo-wrapper/);
    expect(headerSource).toMatch(/queue-bubble/);
    const wrapperIdx = headerSource.indexOf('header__logo-wrapper');
    const bubbleIdx = headerSource.indexOf('queue-bubble');
    expect(wrapperIdx).toBeGreaterThanOrEqual(0);
    expect(bubbleIdx).toBeGreaterThanOrEqual(0);
    expect(bubbleIdx).toBeGreaterThan(wrapperIdx);
  });
});

// ---------------------------------------------------------------------------
// queue-bubble CSS positioning — requires positioned ancestor
// ---------------------------------------------------------------------------

describe('CSS queue-bubble positioning', () => {
  it('defines .queue-bubble with position: absolute', () => {
    expect(templateSource).toMatch(/\.queue-bubble\s*\{[^}]*position\s*:\s*absolute/s);
  });

  it('defines .header__logo-wrapper with position: relative', () => {
    expect(templateSource).toMatch(/\.header__logo-wrapper\s*\{[^}]*position\s*:\s*relative/s);
  });

  it('defines .queue-bubble with a z-index', () => {
    expect(templateSource).toMatch(/\.queue-bubble\s*\{[^}]*z-index\s*:/s);
  });

  it('defines .queue-bubble with a background color', () => {
    expect(templateSource).toMatch(/\.queue-bubble\s*\{[^}]*background/s);
  });
});
