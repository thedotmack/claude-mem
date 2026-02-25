import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useProjectActions } from '../hooks/useProjectActions';
import type { ProjectRowCounts } from '../hooks/useProjectActions';
import { ProjectActionDialog } from './ProjectActionDialog';
import { logger } from '../utils/logger';

export interface ProjectDropdownProps {
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  onProjectsChanged: () => void;
}

interface DialogState {
  action: 'rename' | 'merge' | 'delete';
  project: string;
  rowCounts: ProjectRowCounts | null;
}

export function ProjectDropdown({
  projects,
  currentFilter,
  onFilterChange,
  onProjectsChanged,
}: ProjectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { getRowCounts, renameProject, mergeProject, deleteProject, isLoading, error } = useProjectActions();

  // Close dropdown on outside click
  useEffect(() => {
    function handleMousedown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setActiveMenu(null);
      }
    }
    document.addEventListener('mousedown', handleMousedown);
    return () => { document.removeEventListener('mousedown', handleMousedown); };
  }, []);

  // Close dropdown on Escape key
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setActiveMenu(null);
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => { document.removeEventListener('keydown', handleKeydown); };
  }, []);

  const handleSelect = useCallback((value: string) => {
    onFilterChange(value);
    setIsOpen(false);
    setActiveMenu(null);
  }, [onFilterChange]);

  const handleKebabClick = useCallback((e: React.MouseEvent, project: string) => {
    e.stopPropagation();
    setActiveMenu(prev => prev === project ? null : project);
  }, []);

  const handleActionClick = useCallback(async (e: React.MouseEvent, action: 'rename' | 'merge' | 'delete', project: string) => {
    e.stopPropagation();
    setActiveMenu(null);
    setIsOpen(false);
    try {
      const counts = await getRowCounts(project);
      setDialogState({ action, project, rowCounts: counts });
    } catch {
      logger.error('ProjectDropdown', `Failed to get counts for project: ${project}`);
      setDialogState({ action, project, rowCounts: null });
    }
  }, [getRowCounts]);

  const handleDialogConfirm = useCallback(async (params: { newName?: string; targetProject?: string }) => {
    if (!dialogState) return;
    const { action, project } = dialogState;
    try {
      if (action === 'rename' && params.newName) {
        await renameProject(project, params.newName);
      } else if (action === 'merge' && params.targetProject) {
        await mergeProject(project, params.targetProject);
      } else if (action === 'delete') {
        await deleteProject(project);
      }
      setDialogState(null);
      onProjectsChanged();
      // Update filter to follow the project through rename/merge, or clear on delete
      if (currentFilter === project) {
        if (action === 'rename' && params.newName) {
          onFilterChange(params.newName);
        } else if (action === 'merge' && params.targetProject) {
          onFilterChange(params.targetProject);
        } else {
          onFilterChange('');
        }
      }
    } catch {
      // Error is shown in the dialog via the error prop
      logger.error('ProjectDropdown', `Action ${action} failed for project: ${project}`);
    }
  }, [dialogState, renameProject, mergeProject, deleteProject, onProjectsChanged, currentFilter, onFilterChange]);

  const handleDialogCancel = useCallback(() => {
    setDialogState(null);
  }, []);

  const displayLabel = currentFilter === '' ? 'All Projects' : currentFilter;

  return (
    <div className="project-dropdown" ref={wrapperRef}>
      <button
        className="project-dropdown__trigger"
        aria-label="Filter by project"
        onClick={() => { setIsOpen(prev => !prev); setActiveMenu(null); }}
      >
        <span className="project-dropdown__item-name">{displayLabel}</span>
      </button>

      {isOpen && (
        <div className="project-dropdown__menu">
          <div
            className={`project-dropdown__item${currentFilter === '' ? ' project-dropdown__item--selected' : ''}`}
            onClick={() => { handleSelect(''); }}
          >
            <span className="project-dropdown__item-name">All Projects</span>
          </div>

          {projects.map(project => (
            <div
              key={project}
              className={`project-dropdown__item${currentFilter === project ? ' project-dropdown__item--selected' : ''}`}
              onClick={() => { handleSelect(project); }}
            >
              <span className="project-dropdown__item-name">{project}</span>
              <button
                className="project-dropdown__kebab"
                onClick={(e) => { handleKebabClick(e, project); }}
                aria-label={`Actions for ${project}`}
              >
                &#8943;
              </button>

              {activeMenu === project && (
                <div className="project-dropdown__action-menu" onClick={e => { e.stopPropagation(); }}>
                  <div
                    className="project-dropdown__action-item"
                    onClick={(e) => { void handleActionClick(e, 'rename', project); }}
                  >
                    Rename
                  </div>
                  <div
                    className="project-dropdown__action-item"
                    onClick={(e) => { void handleActionClick(e, 'merge', project); }}
                  >
                    Merge
                  </div>
                  <div
                    className="project-dropdown__action-item project-dropdown__action-item--danger"
                    onClick={(e) => { void handleActionClick(e, 'delete', project); }}
                  >
                    Delete
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {dialogState !== null && (
        <ProjectActionDialog
          action={dialogState.action}
          project={dialogState.project}
          projects={projects}
          rowCounts={dialogState.rowCounts}
          isLoading={isLoading}
          error={error}
          onConfirm={(params) => { void handleDialogConfirm(params); }}
          onCancel={handleDialogCancel}
        />
      )}
    </div>
  );
}
