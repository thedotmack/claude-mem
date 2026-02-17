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

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HEADER_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/Header.tsx'
);

function readHeader(): string {
  return fs.readFileSync(HEADER_SRC, 'utf-8');
}

// ---------------------------------------------------------------------------
// Removed elements — these must NOT appear in the header
// ---------------------------------------------------------------------------

describe('Header does NOT render ThemeToggle', () => {
  it('does not import ThemeToggle', () => {
    const src = readHeader();
    expect(src).not.toMatch(/import.*ThemeToggle/);
  });

  it('does not use <ThemeToggle', () => {
    const src = readHeader();
    expect(src).not.toMatch(/<ThemeToggle/);
  });

  it('does not accept themePreference prop', () => {
    const src = readHeader();
    expect(src).not.toMatch(/themePreference\s*:/);
  });

  it('does not accept onThemeChange prop', () => {
    const src = readHeader();
    expect(src).not.toMatch(/onThemeChange\s*:/);
  });
});

describe('Header does NOT render a docs link', () => {
  it('does not contain a link to docs.magic-claude-mem.ai', () => {
    const src = readHeader();
    expect(src).not.toMatch(/docs\.magic-claude-mem\.ai/);
  });

  it('does not render an icon-link anchor tag', () => {
    const src = readHeader();
    // The docs link used className="icon-link"
    expect(src).not.toMatch(/className="icon-link"/);
  });
});

describe('Header does NOT render GitHubStarsButton', () => {
  it('does not import GitHubStarsButton', () => {
    const src = readHeader();
    expect(src).not.toMatch(/import.*GitHubStarsButton/);
  });

  it('does not use <GitHubStarsButton', () => {
    const src = readHeader();
    expect(src).not.toMatch(/<GitHubStarsButton/);
  });
});

// ---------------------------------------------------------------------------
// Required elements — these MUST appear in the header
// ---------------------------------------------------------------------------

describe('Header renders SearchBar', () => {
  it('imports SearchBar', () => {
    const src = readHeader();
    expect(src).toMatch(/import.*SearchBar/);
  });

  it('renders <SearchBar', () => {
    const src = readHeader();
    expect(src).toMatch(/<SearchBar/);
  });
});

describe('Header renders project selector', () => {
  it('renders a <select> for project filtering', () => {
    const src = readHeader();
    expect(src).toMatch(/<select/);
  });

  it('renders All Projects option', () => {
    const src = readHeader();
    expect(src).toMatch(/All Projects/);
  });
});

describe('Header renders settings button', () => {
  it('renders an element with class settings-btn', () => {
    const src = readHeader();
    expect(src).toMatch(/settings-btn/);
  });

  it('calls onContextPreviewToggle when settings button is clicked', () => {
    const src = readHeader();
    expect(src).toMatch(/onContextPreviewToggle/);
  });
});

describe('Header renders filter toggle button', () => {
  it('renders an element with class filter-toggle-btn', () => {
    const src = readHeader();
    expect(src).toMatch(/filter-toggle-btn/);
  });

  it('calls onFilterToggle prop when clicked', () => {
    const src = readHeader();
    expect(src).toMatch(/onFilterToggle/);
  });

  it('does NOT manage filterBarOpen state internally', () => {
    const src = readHeader();
    expect(src).not.toMatch(/filterBarOpen/);
  });
});

describe('Header does NOT render FilterBar', () => {
  it('does not import FilterBar', () => {
    const src = readHeader();
    expect(src).not.toMatch(/import.*FilterBar/);
  });

  it('does not render <FilterBar', () => {
    const src = readHeader();
    expect(src).not.toMatch(/<FilterBar/);
  });

  it('does not accept filter-related props (filters, onToggleObsType, etc)', () => {
    const src = readHeader();
    // These props were passed through Header to FilterBar - now removed
    expect(src).not.toMatch(/onToggleObsType\s*[,:]/);
    expect(src).not.toMatch(/onToggleConcept\s*[,:]/);
    expect(src).not.toMatch(/onToggleItemKind\s*[,:]/);
    expect(src).not.toMatch(/onDateRangeChange\s*[,:]/);
    expect(src).not.toMatch(/onClearAllFilters\s*[,:]/);
  });
});

describe('Header renders logo', () => {
  it('renders the logomark image', () => {
    const src = readHeader();
    expect(src).toMatch(/logomark/);
  });

  it('renders magic-claude-mem text', () => {
    const src = readHeader();
    expect(src).toMatch(/magic-claude-mem/);
  });

  it('renders logo-text span', () => {
    const src = readHeader();
    expect(src).toMatch(/logo-text/);
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
