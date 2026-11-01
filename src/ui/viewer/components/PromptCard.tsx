import React, { useState } from 'react';
import { UserPrompt } from '../types';
import { formatDate } from '../utils/formatters';

interface PromptCardProps {
  prompt: UserPrompt;
}

// A prompt past these bounds renders with a line clamp plus a "Show more"
// disclosure (#4757): machine-driven sessions (`claude -p`, orchestration
// loops) produce multi-thousand-character "user" turns that otherwise render
// as a card taller than the viewport and push the observations and summaries
// off screen. Line count covers multi-line prompts; the character floor
// covers single-line prompts that wrap past the clamp once rendered.
const CLAMP_LINES = 8;
const CLAMP_MIN_CHARS = 600;

export function PromptCard({ prompt }: PromptCardProps) {
  const [expanded, setExpanded] = useState(false);
  const date = formatDate(prompt.created_at_epoch);
  const isLong =
    prompt.prompt_text.split('\n').length > CLAMP_LINES ||
    prompt.prompt_text.length > CLAMP_MIN_CHARS;
  const clamped = isLong && !expanded;

  return (
    <div className="card prompt-card">
      <div className="card-header">
        <div className="card-header-left">
          <span className="card-type">Prompt</span>
          <span className={`card-source source-${prompt.platform_source || 'claude'}`}>
            {prompt.platform_source || 'claude'}
          </span>
          <span className="card-project">{prompt.project}</span>
        </div>
      </div>
      <div className={`card-content${clamped ? ' card-content-clamped' : ''}`}>
        {prompt.prompt_text}
      </div>
      {isLong && (
        <button
          type="button"
          className="prompt-show-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      <div className="card-meta">
        <span className="meta-date">#{prompt.id} • {date}</span>
      </div>
    </div>
  );
}
