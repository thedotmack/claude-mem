import React from 'react';
import { UserPrompt } from '../types';

interface PromptCardProps {
  prompt: UserPrompt;
  isProcessing?: boolean;
}

export function PromptCard({ prompt, isProcessing }: PromptCardProps) {
  return (
    <div className="card prompt-card">
      <div className="card-header">
        <span className="card-type">Prompt</span>
        <span>#{prompt.prompt_number}</span>
        {isProcessing && (
          <span className="processing-indicator">
            <span className="spinner"></span>
            Processing...
          </span>
        )}
      </div>
      <div className="card-content">
        {prompt.prompt_text}
      </div>
      <div className="card-meta">
        {new Date(prompt.created_at_epoch).toLocaleString()}
      </div>
    </div>
  );
}
