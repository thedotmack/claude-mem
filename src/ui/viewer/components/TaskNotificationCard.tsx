import React, { useState } from 'react';
import type { UserPrompt } from '../types';
import { parseTaskNotification } from '../utils/taskNotification';
import { formatDate } from '../utils/formatters';

interface TaskNotificationCardProps {
  prompt: UserPrompt;
}

export function TaskNotificationCard({ prompt }: TaskNotificationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const date = formatDate(prompt.created_at_epoch);
  const { taskId, status, summary, result } = parseTaskNotification(prompt.prompt_text);

  return (
    <div
      className="card task-notification-card"
      data-testid="task-notification-card"
      aria-expanded={expanded}
    >
      <div className="task-notification-card__header">
        <span className="task-notification-card__type-badge">TASK</span>
        {taskId && (
          <span className="task-notification-card__task-id">{taskId}</span>
        )}
        {status && (
          <span className="task-notification-card__status">{status}</span>
        )}
        <span className="task-notification-card__date">{date}</span>
      </div>

      {summary && (
        <div className="task-notification-card__summary">{summary}</div>
      )}

      {!summary && !taskId && (
        <div className="task-notification-card__raw">{prompt.prompt_text}</div>
      )}

      {result && (
        <button
          className="task-notification-card__toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Hide result' : 'Show result'}
        </button>
      )}

      {expanded && result && (
        <div className="task-notification-card__result" data-testid="task-notification-result">
          {result}
        </div>
      )}
    </div>
  );
}
