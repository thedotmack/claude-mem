// Normalized viewer shape consumed by the redesign components.
// Source of truth: /tmp/cmem-redesign/cmem-viewer/live-data.js (normalize fns)
// + search-agent.jsx (useNotes) and the Phase 0 "Normalized viewer shape".

export interface ViewerObservation {
  id: number;
  session_id: string;
  project: string;
  type: string;
  title: string;
  subtitle: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  /** epoch seconds */
  at: number;
}

export interface ViewerSession {
  id: string;
  project: string;
  /** epoch seconds */
  started: number;
  /** epoch seconds */
  ended: number;
  request: string;
  learned: string;
  completed: string;
  next_steps: string;
  hasSummary: boolean;
}

export interface ViewerPrompt {
  id: string;
  session_id: string;
  project: string;
  text: string;
  n: number;
  /** epoch seconds */
  at: number;
}

/**
 * A saved note. Persisted to localStorage under `cmem-viewer-notes-v1`.
 * Shape mirrors search-agent.jsx `useNotes`: notes carry a synthesized
 * answer (title/text/blocks) plus the observation ids they cite.
 * `saveNote` injects `id` (`note-<ts>`) and `created` (epoch seconds).
 */
export interface ViewerNote {
  id: string;
  /** the query / heading the note was saved under */
  title: string;
  /** the answer text (or rendered note body) */
  text: string;
  /** observation ids cited by this note */
  cited: number[];
  /** epoch seconds */
  created: number;
}

export interface ViewerData {
  sessions: ViewerSession[];
  prompts: ViewerPrompt[];
  observations: ViewerObservation[];
  seedNotes: ViewerNote[];
}
