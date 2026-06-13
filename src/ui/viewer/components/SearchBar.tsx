// Search bar with instant client-side results.
//
// Ported from /tmp/cmem-redesign/cmem-viewer/search-agent.jsx:176-288.
// "/" focuses the input, Esc closes the dropdown, Enter fires onAsk.
// Filtering is 100% client-side (data/search.ts) — no server call.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, TYPE_META } from '../ui/icons.js';
import { baseName, dirName, fmtDayLabel } from '../utils/format.js';
import { searchMemory } from '../data/search.js';
import type { ViewerData } from '../data/viewer-types.js';

export interface SearchBarProps {
  data: ViewerData;
  onAsk: (q: string) => void;
  onJump: (obsId: number) => void;
  onFile: (path: string) => void;
  onConcept: (c: string) => void;
}

export function SearchBar({ data, onAsk, onJump, onFile, onConcept }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchMemory(query, data), [query, data]);
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (
        e.key === '/' &&
        active !== inputRef.current &&
        !['INPUT', 'TEXTAREA'].includes(active?.tagName ?? '')
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const fireAsk = () => {
    if (!hasQuery) return;
    onAsk(query.trim());
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="search-wrap" ref={wrapRef}>
      <div className={'search-pill' + (open && hasQuery ? ' engaged' : '')}>
        <Icon name="search" size={19} className="search-glyph" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search your memory…"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fireAsk();
            if (e.key === 'Escape') {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {hasQuery ? (
          <button
            className="search-clear"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            <Icon name="x" size={14} />
          </button>
        ) : (
          <kbd className="search-kbd">/</kbd>
        )}
      </div>

      {open && hasQuery && (
        <div className="search-drop">
          <button className="ask-row" onClick={fireAsk}>
            <span className="ask-glyph">
              <Icon name="sparkles" size={16} />
            </span>
            <span className="ask-text">
              Ask your agent: <em>“{query.trim()}”</em>
            </span>
            <span className="ask-hint">runs in background · ⏎</span>
          </button>

          {results.observations.length > 0 && (
            <div className="drop-section">
              <p className="drop-label">Memories</p>
              {results.observations.map((o) => {
                const m = TYPE_META[o.type] || TYPE_META.feature;
                return (
                  <button
                    key={o.id}
                    className="drop-row"
                    onClick={() => {
                      onJump(o.id);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    <span className="obs-type-bubble sm" style={{ background: m.bg, color: m.fg }}>
                      <Icon name={m.icon} size={12} />
                    </span>
                    <span className="drop-row-title">{o.title}</span>
                    <span className="drop-row-meta">
                      {o.project} · {fmtDayLabel(o.at).lead}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {results.files.length > 0 && (
            <div className="drop-section">
              <p className="drop-label">Files</p>
              {results.files.map(([f, n]) => (
                <button
                  key={f}
                  className="drop-row"
                  onClick={() => {
                    onFile(f);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className="drop-file-glyph">
                    <Icon name="fileCode" size={14} />
                  </span>
                  <span className="drop-row-title mono">
                    {baseName(f)}
                    <span className="drop-dir">{dirName(f)}</span>
                  </span>
                  <span className="drop-row-meta">
                    {n} {n === 1 ? 'memory' : 'memories'}
                  </span>
                </button>
              ))}
            </div>
          )}

          {results.concepts.length > 0 && (
            <div className="drop-section">
              <p className="drop-label">Concepts</p>
              <div className="drop-concepts">
                {results.concepts.map((c) => (
                  <button
                    key={c}
                    className="concept-chip"
                    onClick={() => {
                      onConcept(c);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.observations.length === 0 &&
            results.files.length === 0 &&
            results.concepts.length === 0 && (
              <p className="drop-empty">No instant matches — ask your agent instead.</p>
            )}
        </div>
      )}
    </div>
  );
}
