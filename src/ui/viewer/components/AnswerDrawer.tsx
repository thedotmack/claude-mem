// Right drawer: agent answer or saved note, with word-reveal animation.
//
// Ported from /tmp/cmem-redesign/cmem-viewer/search-agent.jsx:317-450
// (StreamedBlocks 317-388, AnswerDrawer 391-450).
// Cite chips call onCite to jump to the cited observation.

import React, { useEffect, useMemo, useState } from 'react';
import { Icon, TYPE_META } from '../ui/icons.js';
import { fmtDayLabel } from '../utils/format.js';
import type { AnswerBlock } from '../data/search.js';
import type { ViewerObservation } from '../data/viewer-types.js';
import type { AgentSession } from '../hooks/useAgentSessions.js';
import type { SavedNote } from '../hooks/useNotes.js';

/** Drawer target: an agent session or a saved note, by id. */
export interface DrawerTarget {
  type: 'agent' | 'note';
  id: string;
}

/** Map of observation id → observation, for resolving cite chips. */
export type CitedObs = Record<number, ViewerObservation | undefined>;

// ---------- Streaming block renderer ----------
interface StreamedBlocksProps {
  blocks: AnswerBlock[];
  animate: boolean;
  citedObs: CitedObs;
  onCite: (id: number) => void;
}

function StreamedBlocks({ blocks, animate, citedObs, onCite }: StreamedBlocksProps) {
  const totalWords = useMemo(
    () =>
      blocks.reduce(
        (n, b) =>
          n +
          (b.kind === 'p'
            ? b.text.split(' ').length
            : b.kind === 'bullets'
            ? b.items.join(' ').split(' ').length
            : 1),
        0
      ),
    [blocks]
  );
  const [shown, setShown] = useState(animate ? 0 : Infinity);

  useEffect(() => {
    if (!animate) {
      setShown(Infinity);
      return;
    }
    setShown(0);
    let count = 0;
    const iv = setInterval(() => {
      count += 3;
      setShown(count);
      if (count >= totalWords + 5) clearInterval(iv);
    }, 50);
    return () => clearInterval(iv);
  }, [animate, blocks, totalWords]);

  let budget = shown;
  const clip = (text: string): string => {
    const words = text.split(' ');
    if (budget >= words.length) {
      budget -= words.length;
      return text;
    }
    const out = words.slice(0, Math.max(0, budget)).join(' ');
    budget = 0;
    return out;
  };

  return (
    <div className="answer-blocks">
      {blocks.map((b, i) => {
        if (budget <= 0 && shown !== Infinity && i > 0) return null;
        if (b.kind === 'p') {
          const t = shown === Infinity ? b.text : clip(b.text);
          return t ? (
            <p key={i} className="answer-p">
              {t}
            </p>
          ) : null;
        }
        if (b.kind === 'bullets') {
          const items: string[] = [];
          for (const it of b.items) {
            const t = shown === Infinity ? it : clip(it);
            if (t) items.push(t);
            if (budget <= 0 && shown !== Infinity) break;
          }
          return items.length ? (
            <ul key={i} className="answer-bullets">
              {items.map((it, j) => (
                <li key={j}>{it}</li>
              ))}
            </ul>
          ) : null;
        }
        if (b.kind === 'cite' && (shown === Infinity || budget > 0)) {
          return (
            <div key={i} className="answer-cites">
              <p className="drop-label">From memory</p>
              <div className="cite-chips">
                {b.ids.map((id) => {
                  const o = citedObs[id];
                  if (!o) return null;
                  const m = TYPE_META[o.type] || TYPE_META.feature;
                  return (
                    <button key={id} className="cite-chip" onClick={() => onCite(id)}>
                      <span
                        className="obs-type-bubble sm"
                        style={{ background: m.bg, color: m.fg }}
                      >
                        <Icon name={m.icon} size={11} />
                      </span>
                      <span>
                        #{id} {o.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ---------- Right drawer ----------
export interface AnswerDrawerProps {
  drawer: DrawerTarget | null;
  agentSessions: AgentSession[];
  notes: SavedNote[];
  citedObs: CitedObs;
  onClose: () => void;
  onSaveNote: (session: AgentSession) => void;
  onDeleteNote: (id: string) => void;
  onCite: (id: number) => void;
}

export function AnswerDrawer({
  drawer,
  agentSessions,
  notes,
  citedObs,
  onClose,
  onSaveNote,
  onDeleteNote,
  onCite,
}: AnswerDrawerProps) {
  if (!drawer) return null;

  let title: string;
  let blocks: AnswerBlock[];
  let animate = false;
  let isNote = false;
  let noteSaved = false;
  let session: AgentSession | null = null;
  let note: SavedNote | null = null;

  if (drawer.type === 'agent') {
    session = agentSessions.find((s) => s.id === drawer.id) ?? null;
    if (!session || !session.answer) return null;
    title = session.query;
    blocks = session.answer.blocks;
    animate = !session.viewed;
    noteSaved = !!session.savedNoteId;
  } else {
    note = notes.find((n) => n.id === drawer.id) ?? null;
    if (!note) return null;
    title = note.title;
    blocks = note.blocks;
    isNote = true;
  }

  return (
    <aside className="drawer" data-screen-label={isNote ? 'Note' : 'Agent answer'}>
      <div className="drawer-head">
        <span className={'drawer-glyph' + (isNote ? ' note' : '')}>
          <Icon name={isNote ? 'stickyNote' : 'sparkles'} size={17} />
        </span>
        <div className="drawer-head-text">
          <p className="drawer-eyebrow">{isNote ? 'Saved note' : 'Your agent answered'}</p>
          <h3 className="drawer-title">{title}</h3>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="drawer-body">
        <StreamedBlocks blocks={blocks} animate={animate} citedObs={citedObs} onCite={onCite} />
      </div>

      <div className="drawer-foot">
        {isNote && note ? (
          <React.Fragment>
            <span className="drawer-foot-meta">
              Saved{' '}
              {fmtDayLabel(note.created).lead.toLowerCase() === 'today'
                ? 'today'
                : fmtDayLabel(note.created).rest}
            </span>
            <button className="btn-ghost danger" onClick={() => onDeleteNote(note!.id)}>
              <Icon name="trash" size={14} /> Delete note
            </button>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <button className="btn-ghost" onClick={onClose}>
              Dismiss
            </button>
            <button
              className={'btn-primary' + (noteSaved ? ' saved' : '')}
              onClick={() => !noteSaved && session && onSaveNote(session)}
            >
              <Icon name={noteSaved ? 'check' : 'stickyNote'} size={15} />
              {noteSaved ? 'Saved to notes' : 'Save as note'}
            </button>
          </React.Fragment>
        )}
      </div>
    </aside>
  );
}
