import React from 'react';
import { UserPrompt } from '../types';
import { formatDate } from '../utils/formatters';
import { MetadataFooter } from './MetadataFooter';

interface PromptCardProps {
  prompt: UserPrompt;
}

export function PromptCard({ prompt }: PromptCardProps) {
  const date = formatDate(prompt.created_at_epoch);

  return (
    <div className="card prompt-card">
      <div className="card-header">
        <div className="card-header-left">
          <span className="card-type">Prompt</span>
          <span className="card-project">{prompt.project}</span>
        </div>
      </div>
      <div className="card-content">
        {prompt.prompt_text}
      </div>
      <div className="card-meta">
        <MetadataFooter
          id={prompt.id}
          date={date}
          node={prompt.node}
          platform={prompt.platform}
          instance={prompt.instance}
        />
      </div>
    </div>
  );
}
