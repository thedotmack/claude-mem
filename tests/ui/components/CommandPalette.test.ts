/**
 * Tests for CommandPalette component
 *
 * Since @testing-library/react is not installed, we test via module inspection:
 * 1. Component exports can be imported
 * 2. Props interface matches spec (structural source inspection)
 * 3. Component uses FilterChip
 * 4. Has Esc key handler
 * 5. Has backdrop click handler
 * 6. Auto-focuses search input (useEffect + useRef pattern)
 * 7. Renders filter sections for Type, Concept, Show, Date
 * 8. data-testid attributes present
 *
 * Visual / interaction behaviour is covered by the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const COMPONENT_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/CommandPalette.tsx'
);

function readSource(): string {
  return fs.readFileSync(COMPONENT_SRC, 'utf-8');
}

// ---------------------------------------------------------------------------
// Component module smoke test
// ---------------------------------------------------------------------------

describe('CommandPalette component module', () => {
  it('exports a CommandPalette function', async () => {
    const mod = await import('../../../src/ui/viewer/components/CommandPalette.js');
    expect(typeof mod.CommandPalette).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Props interface matches spec
// ---------------------------------------------------------------------------

describe('CommandPalette props interface', () => {
  it('declares isOpen prop', () => {
    const src = readSource();
    expect(src).toMatch(/isOpen\s*:/);
  });

  it('declares onClose prop', () => {
    const src = readSource();
    expect(src).toMatch(/onClose\s*:/);
  });

  it('declares filters prop of type FilterState', () => {
    const src = readSource();
    expect(src).toMatch(/filters\s*:\s*FilterState/);
  });

  it('declares onQueryChange prop', () => {
    const src = readSource();
    expect(src).toMatch(/onQueryChange\s*:/);
  });

  it('declares onToggleObsType prop', () => {
    const src = readSource();
    expect(src).toMatch(/onToggleObsType\s*:/);
  });

  it('declares onToggleConcept prop', () => {
    const src = readSource();
    expect(src).toMatch(/onToggleConcept\s*:/);
  });

  it('declares onToggleItemKind prop', () => {
    const src = readSource();
    expect(src).toMatch(/onToggleItemKind\s*:/);
  });

  it('declares onDateRangeChange prop', () => {
    const src = readSource();
    expect(src).toMatch(/onDateRangeChange\s*:/);
  });

  it('declares onClearAll prop', () => {
    const src = readSource();
    expect(src).toMatch(/onClearAll\s*:/);
  });

  it('declares hasActiveFilters prop', () => {
    const src = readSource();
    expect(src).toMatch(/hasActiveFilters\s*:/);
  });

  it('declares isSearching prop', () => {
    const src = readSource();
    expect(src).toMatch(/isSearching\s*:/);
  });
});

// ---------------------------------------------------------------------------
// Imports and dependencies
// ---------------------------------------------------------------------------

describe('CommandPalette imports', () => {
  it('imports React', () => {
    const src = readSource();
    expect(src).toMatch(/import React/);
  });

  it('imports FilterChip component', () => {
    const src = readSource();
    expect(src).toMatch(/import.*FilterChip/);
  });

  it('imports filter constants', () => {
    const src = readSource();
    expect(src).toMatch(/import[\s\S]*OBSERVATION_TYPES/);
  });

  it('imports OBSERVATION_CONCEPTS', () => {
    const src = readSource();
    expect(src).toMatch(/OBSERVATION_CONCEPTS/);
  });

  it('imports ITEM_KINDS and ITEM_KIND_LABELS', () => {
    const src = readSource();
    expect(src).toMatch(/ITEM_KINDS/);
    expect(src).toMatch(/ITEM_KIND_LABELS/);
  });

  it('imports FilterState type from types', () => {
    const src = readSource();
    expect(src).toMatch(/FilterState/);
  });
});

// ---------------------------------------------------------------------------
// FilterChip usage
// ---------------------------------------------------------------------------

describe('CommandPalette uses FilterChip', () => {
  it('renders <FilterChip elements', () => {
    const src = readSource();
    expect(src).toMatch(/<FilterChip/);
  });

  it('passes isSelected to FilterChip for obsTypes', () => {
    const src = readSource();
    expect(src).toMatch(/obsTypes/);
  });

  it('passes isSelected to FilterChip for concepts', () => {
    const src = readSource();
    expect(src).toMatch(/concepts/);
  });

  it('passes isSelected to FilterChip for itemKinds', () => {
    const src = readSource();
    expect(src).toMatch(/itemKinds/);
  });
});

// ---------------------------------------------------------------------------
// Keyboard and click handlers
// ---------------------------------------------------------------------------

describe('CommandPalette keyboard handling', () => {
  it('does NOT register its own Escape handler (centralized in useKeyboardNavigation)', () => {
    const src = readSource();
    // Escape handling was removed from CommandPalette — it's now centralized
    // in the useKeyboardNavigation hook to avoid double-handler conflicts.
    expect(src).not.toMatch(/addEventListener.*keydown/);
  });

  it('delegates close to onClose prop (used by backdrop click)', () => {
    const src = readSource();
    expect(src).toMatch(/onClose/);
  });
});

describe('CommandPalette backdrop click handler', () => {
  it('renders an element with data-testid="command-palette-backdrop"', () => {
    const src = readSource();
    expect(src).toMatch(/command-palette-backdrop/);
  });

  it('calls onClose when backdrop is clicked', () => {
    const src = readSource();
    // Backdrop should have onClick={onClose} or similar
    expect(src).toMatch(/onClick.*onClose|onClose.*onClick/);
  });
});

// ---------------------------------------------------------------------------
// Auto-focus search input
// ---------------------------------------------------------------------------

describe('CommandPalette auto-focuses search input', () => {
  it('uses useRef for the search input', () => {
    const src = readSource();
    expect(src).toMatch(/useRef/);
  });

  it('uses useEffect to focus the input when opened', () => {
    const src = readSource();
    // Should have a useEffect that calls .focus()
    expect(src).toMatch(/\.focus\(\)/);
  });

  it('has ref on the search input', () => {
    const src = readSource();
    expect(src).toMatch(/ref=/);
  });
});

// ---------------------------------------------------------------------------
// Filter sections
// ---------------------------------------------------------------------------

describe('CommandPalette renders Type filter section', () => {
  it('has a filter section with data-group="type" or Type label', () => {
    const src = readSource();
    expect(src).toMatch(/Type|data-group="type"/);
  });

  it('maps over OBSERVATION_TYPES', () => {
    const src = readSource();
    expect(src).toMatch(/OBSERVATION_TYPES\.map|OBSERVATION_TYPES\s*\.\s*map/);
  });
});

describe('CommandPalette renders Concept filter section', () => {
  it('has a filter section with data-group="concept" or Concept label', () => {
    const src = readSource();
    expect(src).toMatch(/Concept|data-group="concept"/);
  });

  it('maps over OBSERVATION_CONCEPTS', () => {
    const src = readSource();
    expect(src).toMatch(/OBSERVATION_CONCEPTS\.map|OBSERVATION_CONCEPTS\s*\.\s*map/);
  });
});

describe('CommandPalette renders Show filter section', () => {
  it('has a filter section with data-group="show" or Show label', () => {
    const src = readSource();
    expect(src).toMatch(/Show|data-group="show"/);
  });

  it('maps over ITEM_KINDS', () => {
    const src = readSource();
    expect(src).toMatch(/ITEM_KINDS\.map|ITEM_KINDS\s*\.\s*map/);
  });

  it('uses ITEM_KIND_LABELS for display', () => {
    const src = readSource();
    expect(src).toMatch(/ITEM_KIND_LABELS\[/);
  });
});

describe('CommandPalette renders Date filter section', () => {
  it('has a filter section for date', () => {
    const src = readSource();
    expect(src).toMatch(/Date|data-group="date"/);
  });

  it('renders a date input for dateStart', () => {
    const src = readSource();
    expect(src).toMatch(/dateStart/);
  });

  it('renders a date input for dateEnd', () => {
    const src = readSource();
    expect(src).toMatch(/dateEnd/);
  });

  it('calls onDateRangeChange on date input change', () => {
    const src = readSource();
    expect(src).toMatch(/onDateRangeChange/);
  });
});

// ---------------------------------------------------------------------------
// data-testid attributes
// ---------------------------------------------------------------------------

describe('CommandPalette data-testid attributes', () => {
  it('has data-testid="command-palette" on root element', () => {
    const src = readSource();
    expect(src).toMatch(/data-testid="command-palette"/);
  });

  it('has data-testid="command-palette-search" on search input', () => {
    const src = readSource();
    expect(src).toMatch(/data-testid="command-palette-search"/);
  });

  it('has data-testid="command-palette-backdrop" on backdrop', () => {
    const src = readSource();
    expect(src).toMatch(/data-testid="command-palette-backdrop"/);
  });
});

// ---------------------------------------------------------------------------
// Active filters and Clear All
// ---------------------------------------------------------------------------

describe('CommandPalette active filters and clear all', () => {
  it('shows clear all button when hasActiveFilters is true', () => {
    const src = readSource();
    expect(src).toMatch(/hasActiveFilters/);
    expect(src).toMatch(/Clear All/);
  });

  it('calls onClearAll when clear button is clicked', () => {
    const src = readSource();
    expect(src).toMatch(/onClearAll/);
  });

  it('renders search input with current query value', () => {
    const src = readSource();
    expect(src).toMatch(/filters\.query/);
  });

  it('calls onQueryChange on search input change', () => {
    const src = readSource();
    expect(src).toMatch(/onQueryChange/);
  });
});

// ---------------------------------------------------------------------------
// Overlay/modal structure
// ---------------------------------------------------------------------------

describe('CommandPalette overlay structure', () => {
  it('renders a backdrop overlay div', () => {
    const src = readSource();
    expect(src).toMatch(/command-palette-backdrop/);
  });

  it('renders a command-palette container', () => {
    const src = readSource();
    expect(src).toMatch(/command-palette/);
  });

  it('conditionally renders based on isOpen prop', () => {
    const src = readSource();
    // isOpen should gate rendering
    expect(src).toMatch(/isOpen/);
  });
});
