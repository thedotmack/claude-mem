// Saved notes — persisted to localStorage under `cmem-viewer-notes-v1`.
//
// Ported from /tmp/cmem-redesign/cmem-viewer/search-agent.jsx:148-173.
// localStorage/Date.now are fine here: this is browser runtime code.

import { useCallback, useEffect, useState } from 'react';
import type { ViewerNote } from '../data/viewer-types.js';
import type { AnswerBlock, ParagraphBlock } from '../data/search.js';

export const NOTES_KEY = 'cmem-viewer-notes-v1';

/**
 * A persisted note. Extends the canonical {@link ViewerNote} with the
 * rendered answer `blocks` so the AnswerDrawer can replay them.
 */
export interface SavedNote extends ViewerNote {
  blocks: AnswerBlock[];
}

/** Fields a caller supplies; `id`/`created` are injected on save. */
export type NoteInput = Omit<SavedNote, 'id' | 'created'>;

export interface UseNotes {
  notes: SavedNote[];
  saveNote: (note: NoteInput) => void;
  deleteNote: (id: string) => void;
}

/**
 * Coerce a canonical {@link ViewerNote} (no rendered `blocks`) into a
 * {@link SavedNote} by synthesizing a single paragraph block from its `text`.
 * Seed notes from `buildData` carry no blocks; stored notes already do.
 */
function toSavedNote(note: ViewerNote | SavedNote): SavedNote {
  if ('blocks' in note && Array.isArray((note as SavedNote).blocks)) {
    return note as SavedNote;
  }
  const blocks: AnswerBlock[] = note.text
    ? [{ kind: 'p', text: note.text } as ParagraphBlock]
    : [];
  return { ...note, blocks };
}

export function useNotes(seedNotes: ViewerNote[]): UseNotes {
  const [notes, setNotes] = useState<SavedNote[]>(() => {
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      if (raw) return (JSON.parse(raw) as SavedNote[]).map(toSavedNote);
    } catch (e) {
      /* ignore */
    }
    return seedNotes.map(toSavedNote);
  });

  useEffect(() => {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
    } catch (e) {
      /* ignore */
    }
  }, [notes]);

  const saveNote = useCallback((note: NoteInput) => {
    setNotes((prev) => [
      { ...note, id: 'note-' + Date.now(), created: Math.floor(Date.now() / 1000) },
      ...prev,
    ]);
  }, []);

  const deleteNote = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  return { notes, saveNote, deleteNote };
}
