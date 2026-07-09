// Interactive agent view — a conversation thread over your memory.
//
// Replaces the toast → drawer flow for agent asks: asking from the search
// bar opens this panel, each ask becomes a turn (your question → the agent
// working → the streamed answer with citations), and the footer input keeps
// the conversation going with follow-ups.

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/icons.js';
import { StreamedBlocks } from './AnswerDrawer.js';
import type { CitedObs } from './AnswerDrawer.js';
import type { AgentSession } from '../hooks/useAgentSessions.js';

export interface AgentPanelProps {
  open: boolean;
  sessions: AgentSession[];
  citedObs: CitedObs;
  onAsk: (query: string) => void;
  onCite: (id: number) => void;
  onSaveNote: (session: AgentSession) => void;
  onClose: () => void;
}

export function AgentPanel({
  open, sessions, citedObs, onAsk, onCite, onSaveNote, onClose
}: AgentPanelProps) {
  const [draft, setDraft] = useState('');
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // follow the conversation: scroll to the newest turn as it arrives/streams
  const lastSig = sessions.map((s) => s.id + ':' + s.status).join('|');
  useEffect(() => {
    if (!open) return;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, lastSig]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const fireAsk = () => {
    const q = draft.trim();
    if (!q) return;
    onAsk(q);
    setDraft('');
  };

  return (
    <aside className="drawer agent-panel" data-screen-label="Memory agent">
      <div className="drawer-head">
        <span className="drawer-glyph">
          <Icon name="sparkles" size={17} />
        </span>
        <div className="drawer-head-text">
          <p className="drawer-eyebrow">Memory agent</p>
          <h3 className="drawer-title">Ask anything you&rsquo;ve worked on</h3>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close agent panel">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="drawer-body ap-thread" ref={threadRef}>
        {sessions.length === 0 && (
          <div className="ap-empty">
            <Icon name="sparkles" size={28} strokeWidth={1.6} />
            <p className="empty-title">Nothing asked yet</p>
            <p className="empty-sub">
              Try &ldquo;what did we decide about the sync container?&rdquo; or
              &ldquo;how does the worker restart?&rdquo;
            </p>
          </div>
        )}

        {sessions.map((s) => (
          <div className="ap-turn" key={s.id}>
            <div className="ap-user">
              <p>{s.query}</p>
            </div>

            {s.status === 'running' || !s.answer ? (
              <div className="ap-stage">
                <img className="ap-stage-mark spin" src="claude-mem-logomark.webp" alt="" />
                <span>{s.stage}</span>
              </div>
            ) : (
              <div className="ap-answer">
                <StreamedBlocks
                  blocks={s.answer.blocks}
                  animate={!s.viewed}
                  citedObs={citedObs}
                  onCite={onCite}
                />
                <div className="ap-answer-foot">
                  <button
                    className={'ap-note-btn' + (s.savedNoteId ? ' saved' : '')}
                    onClick={() => !s.savedNoteId && onSaveNote(s)}
                  >
                    <Icon name={s.savedNoteId ? 'check' : 'stickyNote'} size={13} />
                    {s.savedNoteId ? 'Saved to notes' : 'Save as note'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <form
        className="ap-input"
        onSubmit={(e) => {
          e.preventDefault();
          fireAsk();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          placeholder={sessions.length ? 'Ask a follow-up…' : 'Ask your memory…'}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="ap-send" disabled={!draft.trim()} aria-label="Ask">
          <Icon name="send" size={15} />
        </button>
      </form>
    </aside>
  );
}
