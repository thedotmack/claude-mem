import React from 'react';
import { UserPrompt, FeedItemType } from '../types';
import { formatDate } from '../utils/formatters';
import { DeleteButton } from './DeleteButton';

interface PromptCardProps {
  prompt: UserPrompt;
  onDelete: (itemType: FeedItemType, id: number) => void;
}

export function PromptCard({ prompt, onDelete }: PromptCardProps) {
  const date = formatDate(prompt.created_at_epoch);
  const { t } = useI18n();

  return (
    <div className="card prompt-card">
      <div className="card-header">
        <div className="card-header-left">
          <span className="card-type">{t('card.prompt')}</span>
          <span className={`card-source source-${prompt.platform_source || 'claude'}`}>
            {prompt.platform_source || 'claude'}
          </span>
          <span className="card-project">{prompt.project}</span>
        </div>
        <div className="view-mode-toggles">
          <DeleteButton itemType="prompt" id={prompt.id} onDelete={onDelete} />
        </div>
      </div>
      <div className="card-content">
        {prompt.prompt_text}
      </div>
      <div className="card-meta">
        <span className="meta-date">#{prompt.id} • {date}</span>
      </div>
    </div>
  );
}
