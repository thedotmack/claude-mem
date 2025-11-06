import React from 'react';
import { UserPrompt } from '../types';
import { formatDate } from '../utils/formatters';

interface PromptCardProps {
  prompt: UserPrompt;
}

export function PromptCard({ prompt }: PromptCardProps) {
  return (
    <div className="card prompt-card">
      <div className="card-header">
        <span className="card-type">Prompt</span>
        <span>{prompt.project}</span>
      </div>
      <div className="card-content">
        {prompt.prompt_text}
      </div>
      <div className="card-meta">
        {formatDate(prompt.created_at_epoch)}
      </div>
    </div>
  );
}
