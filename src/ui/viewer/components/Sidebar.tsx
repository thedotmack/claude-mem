// CMEM Viewer — side-drawer body: file tree + saved-notes list.
//
// Ported from /tmp/cmem-redesign/cmem-viewer/app-v4.jsx:114-286
// (buildFileTree 115-126, treeCount 128-132, TreeLevel 134-184, Sidebar 216-286).
// Class names are preserved verbatim so the Phase 1 component CSS targets them.
// No window globals; all data flows through ES imports.

import React, { useMemo, useState } from 'react';
import { Icon } from '../ui/icons.js';
import { fmtDayLabel } from '../utils/format.js';
import type { ViewerData } from '../data/viewer-types.js';
import type { SavedNote } from '../hooks/useNotes.js';

// ---------- file tree ----------
interface FileInfo {
  count: number;
  modified: boolean;
}

interface TreeFile extends FileInfo {
  path: string;
  name: string;
}

interface TreeNode {
  dirs: Record<string, TreeNode>;
  files: TreeFile[];
}

function buildFileTree(entries: [string, FileInfo][]): TreeNode {
  const root: TreeNode = { dirs: {}, files: [] };
  entries.forEach(([path, info]) => {
    const parts = path.split('/');
    let node = root;
    parts.slice(0, -1).forEach((seg) => {
      node = node.dirs[seg] = node.dirs[seg] || { dirs: {}, files: [] };
    });
    node.files.push({ path, name: parts[parts.length - 1], ...info });
  });
  return root;
}

function treeCount(node: TreeNode): number {
  let n = node.files.reduce((s, f) => s + f.count, 0);
  Object.values(node.dirs).forEach((d) => {
    n += treeCount(d);
  });
  return n;
}

interface TreeLevelProps {
  node: TreeNode;
  depth: number;
  prefix: string;
  closed: Record<string, boolean>;
  onToggleDir: (path: string) => void;
  activeFile: string | null;
  onFile: (path: string) => void;
}

function TreeLevel({ node, depth, prefix, closed, onToggleDir, activeFile, onFile }: TreeLevelProps) {
  const dirNames = Object.keys(node.dirs).sort();
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <React.Fragment>
      {dirNames.map((name) => {
        const dirPath = prefix + name;
        const isClosed = !!closed[dirPath];
        const child = node.dirs[name];
        return (
          <React.Fragment key={dirPath}>
            <button
              className="tree-dir"
              style={{ paddingLeft: 8 + depth * 16 }}
              onClick={() => onToggleDir(dirPath)}
              aria-expanded={!isClosed}
            >
              <Icon name="chevronDown" size={12} className={'tree-caret' + (isClosed ? ' closed' : '')} />
              <Icon name="folder" size={13} className="tree-dir-glyph" />
              <span className="tree-dir-name">{name}</span>
              {isClosed && <span className="file-row-count">{treeCount(child)}</span>}
            </button>
            {!isClosed && (
              <TreeLevel
                node={child}
                depth={depth + 1}
                prefix={dirPath + '/'}
                closed={closed}
                onToggleDir={onToggleDir}
                activeFile={activeFile}
                onFile={onFile}
              />
            )}
          </React.Fragment>
        );
      })}
      {files.map((f) => {
        const active = activeFile === f.path;
        return (
          <button
            key={f.path}
            className={'file-row tree-file' + (active ? ' active' : '')}
            style={{ paddingLeft: 8 + depth * 16 + 18 }}
            title={f.path}
            onClick={() => onFile(f.path)}
          >
            <Icon name={f.modified ? 'pencil' : 'eye'} size={12} className="file-row-glyph" />
            <span className="file-row-name">{f.name}</span>
            <span className="file-row-count">{f.count}</span>
          </button>
        );
      })}
    </React.Fragment>
  );
}

// ---------- sidebar (lives inside the side drawer in v4) ----------
export interface SidebarProps {
  data: ViewerData;
  /** active project filter — scopes the file tree (empty string = all). */
  project?: string;
  /** currently filtered file path, highlighted in the tree. */
  activeFile: string | null;
  /** click a file: filters the timeline (toggles off when clicking the active file). */
  onFileClick: (path: string) => void;
  notes: SavedNote[];
  onOpenNote: (id: string) => void;
  /** id of the note currently shown in the answer drawer, if any. */
  activeNoteId?: string | null;
  onClose: () => void;
}

export function Sidebar({
  data,
  project = '',
  activeFile,
  onFileClick,
  notes,
  onOpenNote,
  activeNoteId = null,
  onClose: _onClose,
}: SidebarProps) {
  const [closedDirs, setClosedDirs] = useState<Record<string, boolean>>({});

  const fileCounts = useMemo<[string, FileInfo][]>(() => {
    const m = new Map<string, FileInfo>();
    data.observations.forEach((o) => {
      if (project && o.project !== project) return;
      const touched = new Set([...o.files_read, ...o.files_modified]);
      touched.forEach((f) => {
        const e = m.get(f) || { count: 0, modified: false };
        e.count += 1;
        if (o.files_modified.includes(f)) e.modified = true;
        m.set(f, e);
      });
    });
    return [...m.entries()];
  }, [data, project]);

  const tree = useMemo(() => buildFileTree(fileCounts), [fileCounts]);

  return (
    <aside className="sidebar" data-screen-label="Files drawer">
      <section className="side-section">
        <p className="cm-eyebrow side-eyebrow">
          <Icon name="fileCode" size={13} /> Files
        </p>
        <div className="file-list">
          <TreeLevel
            node={tree}
            depth={0}
            prefix=""
            closed={closedDirs}
            onToggleDir={(p) => setClosedDirs((c) => ({ ...c, [p]: !c[p] }))}
            activeFile={activeFile}
            onFile={onFileClick}
          />
        </div>
      </section>

      <section className="side-section">
        <p className="cm-eyebrow side-eyebrow">
          <Icon name="stickyNote" size={13} /> Notes <span className="eyebrow-count">{notes.length}</span>
        </p>
        {notes.length === 0 ? (
          <p className="notes-empty">Ask your agent something, then save the answer — it lands here.</p>
        ) : (
          <div className="note-list">
            {notes.map((n) => (
              <button
                key={n.id}
                className={'note-row' + (activeNoteId === n.id ? ' active' : '')}
                onClick={() => onOpenNote(n.id)}
              >
                <span className="note-row-title">{n.title}</span>
                <span className="note-row-meta">
                  {fmtDayLabel(n.created).lead} · {n.cited.length} cited
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="side-foot">
        <Icon name="database" size={13} />
        <span>
          <strong>{data.observations.length.toLocaleString()}</strong> loaded
        </span>
        <span className="sync-dot"></span>
      </div>
    </aside>
  );
}
