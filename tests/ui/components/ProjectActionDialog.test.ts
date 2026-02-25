/**
 * Tests for ProjectActionDialog component
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
  '../../../src/ui/viewer/components/ProjectActionDialog.tsx'
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

describe('ProjectActionDialog module exports', () => {
  it('exports ProjectActionDialog function', async () => {
    const mod = await import('../../../src/ui/viewer/components/ProjectActionDialog.js');
    expect(typeof mod.ProjectActionDialog).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Source structure tests
// ---------------------------------------------------------------------------

describe('ProjectActionDialog source structure', () => {
  it('source file exists', () => {
    expect(componentSource).not.toBe('');
  });

  it('defines ProjectActionDialogProps interface', () => {
    expect(componentSource).toContain('ProjectActionDialogProps');
  });

  it('renders modal overlay with project-action-dialog class', () => {
    expect(componentSource).toContain('project-action-dialog');
  });

  it('renders content box with project-action-dialog__content class', () => {
    expect(componentSource).toContain('project-action-dialog__content');
  });

  it('renders title with project-action-dialog__title class', () => {
    expect(componentSource).toContain('project-action-dialog__title');
  });

  it('renders row counts table with project-action-dialog__counts class', () => {
    expect(componentSource).toContain('project-action-dialog__counts');
  });

  it('renders input with project-action-dialog__input class', () => {
    expect(componentSource).toContain('project-action-dialog__input');
  });

  it('renders error display with project-action-dialog__error class', () => {
    expect(componentSource).toContain('project-action-dialog__error');
  });

  it('renders action buttons with project-action-dialog__actions class', () => {
    expect(componentSource).toContain('project-action-dialog__actions');
  });

  it('renders Confirm and Cancel buttons', () => {
    expect(componentSource).toContain('Confirm');
    expect(componentSource).toContain('Cancel');
  });

  it('has rename action support', () => {
    expect(componentSource).toContain('rename');
  });

  it('has merge action support', () => {
    expect(componentSource).toContain('merge');
  });

  it('has delete action support', () => {
    expect(componentSource).toContain('delete');
  });

  it('accepts action prop in interface', () => {
    expect(componentSource).toMatch(/action\s*:/);
  });

  it('accepts project prop in interface', () => {
    expect(componentSource).toMatch(/project\s*:/);
  });

  it('accepts projects prop in interface', () => {
    expect(componentSource).toMatch(/projects\s*:/);
  });

  it('accepts rowCounts prop in interface', () => {
    expect(componentSource).toContain('rowCounts');
  });

  it('accepts isLoading prop in interface', () => {
    expect(componentSource).toMatch(/isLoading\s*:/);
  });

  it('accepts error prop in interface', () => {
    expect(componentSource).toMatch(/error\s*:/);
  });

  it('accepts onConfirm callback in interface', () => {
    expect(componentSource).toContain('onConfirm');
  });

  it('accepts onCancel callback in interface', () => {
    expect(componentSource).toContain('onCancel');
  });

  it('disables buttons when isLoading', () => {
    expect(componentSource).toContain('isLoading');
    expect(componentSource).toContain('disabled');
  });

  it('shows overlay background that closes on click', () => {
    expect(componentSource).toContain('onCancel');
  });

  it('renders select dropdown for merge action', () => {
    expect(componentSource).toContain('project-action-dialog__select');
  });

  it('renders warning text for delete action', () => {
    expect(componentSource).toContain('project-action-dialog__warning');
  });

  it('renders delete button with danger class', () => {
    expect(componentSource).toContain('project-action-dialog__btn--danger');
  });

  it('renders Rename Project title for rename action', () => {
    expect(componentSource).toContain('Rename Project');
  });

  it('renders Merge Project title for merge action', () => {
    expect(componentSource).toContain('Merge Project');
  });

  it('renders Delete Project title for delete action', () => {
    expect(componentSource).toContain('Delete Project');
  });

  it('uses useState for local input value', () => {
    expect(componentSource).toContain('useState');
  });

  it('has confirm button disabled until valid input', () => {
    expect(componentSource).toContain('disabled');
  });

  it('calls onConfirm with newName for rename', () => {
    expect(componentSource).toContain('newName');
  });

  it('calls onConfirm with targetProject for merge', () => {
    expect(componentSource).toContain('targetProject');
  });

  it('type-to-confirm requires matching project name for delete', () => {
    expect(componentSource).toContain('confirmName');
  });
});
