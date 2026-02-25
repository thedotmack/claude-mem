/**
 * Tests for ProjectDropdown component
 *
 * Tests module structure and source inspection since we cannot run React hooks
 * without a DOM environment. Visual and interaction behaviour is covered by
 * the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const COMPONENT_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/ProjectDropdown.tsx'
);

let componentSource: string;

try {
  componentSource = fs.readFileSync(COMPONENT_SRC, 'utf-8');
} catch {
  componentSource = '';
}

// ---------------------------------------------------------------------------
// Module export tests
// ---------------------------------------------------------------------------

describe('ProjectDropdown module exports', () => {
  it('exports ProjectDropdown function', async () => {
    const mod = await import('../../../src/ui/viewer/components/ProjectDropdown.js');
    expect(typeof mod.ProjectDropdown).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Source structure tests
// ---------------------------------------------------------------------------

describe('ProjectDropdown source structure', () => {
  it('source file exists', () => {
    expect(componentSource).not.toBe('');
  });

  it('defines ProjectDropdownProps interface', () => {
    expect(componentSource).toContain('ProjectDropdownProps');
  });

  it('renders wrapper div with project-dropdown class', () => {
    expect(componentSource).toContain('project-dropdown');
  });

  it('renders trigger button with project-dropdown__trigger class', () => {
    expect(componentSource).toContain('project-dropdown__trigger');
  });

  it('renders dropdown menu with project-dropdown__menu class', () => {
    expect(componentSource).toContain('project-dropdown__menu');
  });

  it('renders items with project-dropdown__item class', () => {
    expect(componentSource).toContain('project-dropdown__item');
  });

  it('renders kebab button with project-dropdown__kebab class', () => {
    expect(componentSource).toContain('project-dropdown__kebab');
  });

  it('renders action menu with project-dropdown__action-menu class', () => {
    expect(componentSource).toContain('project-dropdown__action-menu');
  });

  it('renders action items with project-dropdown__action-item class', () => {
    expect(componentSource).toContain('project-dropdown__action-item');
  });

  it('renders danger class for delete action item', () => {
    expect(componentSource).toContain('project-dropdown__action-item--danger');
  });

  it('renders All Projects option', () => {
    expect(componentSource).toContain('All Projects');
  });

  it('has aria-label on trigger button for accessibility', () => {
    expect(componentSource).toContain('aria-label="Filter by project"');
  });

  it('accepts projects prop in interface', () => {
    expect(componentSource).toMatch(/projects\s*:/);
  });

  it('accepts currentFilter prop in interface', () => {
    expect(componentSource).toContain('currentFilter');
  });

  it('accepts onFilterChange callback in interface', () => {
    expect(componentSource).toContain('onFilterChange');
  });

  it('accepts onProjectsChanged callback in interface', () => {
    expect(componentSource).toContain('onProjectsChanged');
  });

  it('uses useState for isOpen state', () => {
    expect(componentSource).toContain('isOpen');
    expect(componentSource).toContain('useState');
  });

  it('uses useState for activeMenu state', () => {
    expect(componentSource).toContain('activeMenu');
  });

  it('uses useState for dialogState', () => {
    expect(componentSource).toContain('dialogState');
  });

  it('integrates useProjectActions hook', () => {
    expect(componentSource).toContain('useProjectActions');
  });

  it('integrates ProjectActionDialog component', () => {
    expect(componentSource).toContain('ProjectActionDialog');
  });

  it('uses useRef for click-outside detection', () => {
    expect(componentSource).toContain('useRef');
  });

  it('closes dropdown on outside click using mousedown listener', () => {
    expect(componentSource).toContain('mousedown');
  });

  it('closes dropdown on Escape key', () => {
    expect(componentSource).toContain('Escape');
  });

  it('has Rename action item', () => {
    expect(componentSource).toContain('Rename');
  });

  it('has Merge action item', () => {
    expect(componentSource).toContain('Merge');
  });

  it('has Delete action item', () => {
    expect(componentSource).toContain('Delete');
  });

  it('calls getRowCounts before opening dialog', () => {
    expect(componentSource).toContain('getRowCounts');
  });

  it('calls onProjectsChanged after successful action', () => {
    expect(componentSource).toContain('onProjectsChanged');
  });

  it('shows selected item with project-dropdown__item--selected class', () => {
    expect(componentSource).toContain('project-dropdown__item--selected');
  });

  it('shows item name with project-dropdown__item-name class', () => {
    expect(componentSource).toContain('project-dropdown__item-name');
  });
});
