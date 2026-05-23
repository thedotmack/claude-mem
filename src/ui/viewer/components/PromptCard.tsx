import React from 'react';
import { UserPrompt } from '../types';
import { formatDate } from '../utils/formatters';
import { useI18n } from '../i18n/I18nContext';

interface PromptCardProps {
  prompt: UserPrompt;
}

export function PromptCard({ prompt }: PromptCardProps) {
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
