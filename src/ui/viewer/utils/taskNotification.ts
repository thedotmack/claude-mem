import type { UserPrompt } from '../types';

/**
 * Checks whether a prompt is a task notification by inspecting the start of
 * prompt_text (after trimming leading whitespace).
 */
export function isTaskNotification(prompt: UserPrompt): boolean {
  return prompt.prompt_text.trimStart().startsWith('<task-notification>');
}

export interface TaskNotificationFields {
  taskId: string | null;
  status: string | null;
  summary: string | null;
  result: string | null;
}

/**
 * Extracts fields from task notification XML-like content using regex.
 * Does NOT use DOMParser or any XML library — pure regex extraction.
 * Returns null for any field whose tag is absent or cannot be parsed.
 */
export function parseTaskNotification(text: string): TaskNotificationFields {
  const extract = (tag: string): string | null => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'm').exec(text);
    return match ? match[1].trim() : null;
  };

  return {
    taskId: extract('task-id'),
    status: extract('status'),
    summary: extract('summary'),
    result: extract('result'),
  };
}
