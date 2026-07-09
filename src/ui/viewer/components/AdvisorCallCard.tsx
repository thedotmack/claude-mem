import React from 'react';
import { AdvisorCall } from '../types';
import { formatDate } from '../utils/formatters';

interface AdvisorCallCardProps {
  advisorCall: AdvisorCall;
}

/** 'claude-fable-5' → 'fable-5' for the badge; unknown shapes pass through. */
function shortModelName(model: string): string {
  return model.replace(/^claude-/, '');
}

export function AdvisorCallCard({ advisorCall }: AdvisorCallCardProps) {
  const date = formatDate(advisorCall.occurred_at_epoch);

  return (
    <div className="card advisor-call-card">
      <div className="card-header">
        <div className="card-header-left">
          <span className="card-type">Advisor</span>
          {advisorCall.advisor_model && (
            <span className="advisor-call-model" title={`Advice served by ${advisorCall.advisor_model}`}>
              {shortModelName(advisorCall.advisor_model)}
            </span>
          )}
          <span className={`card-source source-${advisorCall.platform_source || 'claude'}`}>
            {advisorCall.platform_source || 'claude'}
          </span>
          <span className="card-project">{advisorCall.project}</span>
        </div>
      </div>

      {advisorCall.last_user_message && (
        <div className="advisor-call-section">
          <div className="advisor-call-section-label">Turn context</div>
          <div className="advisor-call-context">{advisorCall.last_user_message}</div>
        </div>
      )}

      <div className="advisor-call-section">
        <div className="advisor-call-section-label">Advice</div>
        <div className="advisor-call-advice">{advisorCall.advice}</div>
      </div>

      {advisorCall.transcript_path && (
        <div
          className="advisor-call-transcript-ref"
          title="Forwarded context = the full conversation transcript up to this line, as it existed at call time"
        >
          transcript: {advisorCall.transcript_path}
          {advisorCall.transcript_line_number != null && `:${advisorCall.transcript_line_number}`}
        </div>
      )}

      <div className="card-meta">
        <span className="meta-date">#{advisorCall.id} • {date}</span>
      </div>
    </div>
  );
}
