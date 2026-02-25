import React, { useState } from 'react';
import type { ProjectRowCounts } from '../hooks/useProjectActions';

export interface ProjectActionDialogProps {
  action: 'rename' | 'merge' | 'delete';
  project: string;
  projects: string[];
  rowCounts: ProjectRowCounts | null;
  isLoading: boolean;
  error: string | null;
  onConfirm: (params: { newName?: string; targetProject?: string }) => void;
  onCancel: () => void;
}

function getTitle(action: 'rename' | 'merge' | 'delete'): string {
  switch (action) {
    case 'rename': return 'Rename Project';
    case 'merge': return 'Merge Project';
    case 'delete': return 'Delete Project';
  }
}

export function ProjectActionDialog({
  action,
  project,
  projects,
  rowCounts,
  isLoading,
  error,
  onConfirm,
  onCancel,
}: ProjectActionDialogProps) {
  const [newName, setNewName] = useState('');
  const [targetProject, setTargetProject] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const otherProjects = projects.filter(p => p !== project);

  function isMissingInput(): boolean {
    switch (action) {
      case 'rename': return newName.trim() === '';
      case 'merge': return targetProject === '';
      case 'delete': return confirmName !== project;
    }
  }

  const isConfirmDisabled = isLoading || isMissingInput();

  function handleConfirm() {
    if (action === 'rename') {
      onConfirm({ newName: newName.trim() });
    } else if (action === 'merge') {
      onConfirm({ targetProject });
    } else {
      onConfirm({});
    }
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  }

  return (
    <div className="project-action-dialog" onClick={handleOverlayClick}>
      <div className="project-action-dialog__content">
        <div className="project-action-dialog__title">{getTitle(action)}</div>

        {rowCounts !== null && (
          <table className="project-action-dialog__counts">
            <tbody>
              <tr>
                <td>Sessions</td>
                <td>{rowCounts.sdk_sessions}</td>
              </tr>
              <tr>
                <td>Observations</td>
                <td>{rowCounts.observations}</td>
              </tr>
              <tr>
                <td>Summaries</td>
                <td>{rowCounts.session_summaries}</td>
              </tr>
              <tr>
                <td>Context Injections</td>
                <td>{rowCounts.context_injections}</td>
              </tr>
            </tbody>
          </table>
        )}

        {error !== null && (
          <div className="project-action-dialog__error">{error}</div>
        )}

        {action === 'rename' && (
          <input
            className="project-action-dialog__input"
            type="text"
            placeholder="New project name"
            value={newName}
            onChange={e => { setNewName(e.target.value); }}
            disabled={isLoading}
          />
        )}

        {action === 'merge' && (
          <select
            className="project-action-dialog__select"
            value={targetProject}
            onChange={e => { setTargetProject(e.target.value); }}
            disabled={isLoading}
          >
            <option value="">Select target project...</option>
            {otherProjects.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}

        {action === 'delete' && (
          <>
            <div className="project-action-dialog__warning">
              This will permanently delete all data for project &quot;{project}&quot;,
              including associated user prompts and pending messages.
            </div>
            <input
              className="project-action-dialog__input"
              type="text"
              placeholder={`Type "${project}" to confirm`}
              value={confirmName}
              onChange={e => { setConfirmName(e.target.value); }}
              disabled={isLoading}
            />
          </>
        )}

        <div className="project-action-dialog__actions">
          {action === 'delete' ? (
            <button
              className="project-action-dialog__btn project-action-dialog__btn--danger"
              onClick={handleConfirm}
              disabled={isConfirmDisabled}
            >
              Delete
            </button>
          ) : (
            <button
              className="project-action-dialog__btn"
              onClick={handleConfirm}
              disabled={isConfirmDisabled}
            >
              Confirm
            </button>
          )}
          <button
            className="project-action-dialog__btn"
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
