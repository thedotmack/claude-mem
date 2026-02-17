import React, { useState, useRef, useEffect } from 'react';
import type { UserPrompt } from '../types';
import { formatDate } from '../utils/formatters';

interface PromptCardProps {
  prompt: UserPrompt;
}

export function PromptCard({ prompt }: PromptCardProps) {
  const date = formatDate(prompt.created_at_epoch);
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = contentRef.current;
    if (el) {
      setIsTruncated(el.scrollHeight > el.clientHeight);
    }
  }, [prompt.prompt_text]);

  return (
    <div className="card prompt-card" data-testid="prompt-card" aria-expanded={expanded}>
      <div className="prompt-card__header">
        <span className="prompt-card__badge">#{prompt.id}</span>
        <span className="prompt-card__project">{prompt.project}</span>
        <span className="prompt-card__date">{date}</span>
      </div>
      <div
        ref={contentRef}
        className={`prompt-card__content${expanded ? ' prompt-card__content--expanded' : ''}`}
        data-testid="prompt-card-content"
      >
        {prompt.prompt_text}
      </div>
      {isTruncated && (
        <button
          className="prompt-card__toggle"
          data-testid="prompt-card-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
