/**
 * Terminal renderer for live SSE feed.
 * Formats memory worker SSEBroadcaster events for display in inline or tmux sidebar mode.
 */

import chalk from 'chalk';
import { getTypeIcon } from '../formatters/icons.js';

function formatTime(epoch?: number): string {
  const d = epoch ? new Date(epoch * 1000) : new Date();
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function timestamp(epoch?: number): string {
  return chalk.dim(`[${formatTime(epoch)}]`);
}

/**
 * Render an SSE event received from the worker's /stream endpoint.
 * Returns a formatted string ready to print, or null to skip the event.
 */
export function renderSSEEvent(
  event: { type: string; data: Record<string, unknown> },
): string | null {
  const { type, data } = event;

  switch (type) {
    case 'observation_saved': {
      const obsType = typeof data.type === 'string' ? data.type : 'observation';
      const title = typeof data.title === 'string' ? data.title : '(untitled)';
      const project = typeof data.project === 'string' ? data.project : '';
      const epoch = typeof data.created_at_epoch === 'number' ? data.created_at_epoch : undefined;

      const icon = getTypeIcon(obsType);
      const typeName = obsType.replace(/-/g, ' ');
      const line1 = `${timestamp(epoch)} ${icon} ${chalk.bold(typeName)}: ${chalk.white(title)}`;
      const line2 = project ? chalk.dim(`            project: ${project}`) : '';
      return line2 ? `${line1}\n${line2}` : line1;
    }

    case 'summary_saved': {
      const project = typeof data.project === 'string' ? data.project : '';
      const sessionId = data.content_session_id ?? data.memory_session_id ?? data.session_id;
      const line1 = `${timestamp()} ${chalk.cyan('◆')} ${chalk.bold('summary saved')}${sessionId ? chalk.dim(` (session ${sessionId})`) : ''}`;
      const line2 = project ? chalk.dim(`            project: ${project}`) : '';
      return line2 ? `${line1}\n${line2}` : line1;
    }

    case 'processing_status': {
      const isProcessing = data.isProcessing === true;
      const depth = typeof data.queueDepth === 'number' ? data.queueDepth : 0;
      if (!isProcessing && depth === 0) return null; // skip idle pings
      const label = isProcessing
        ? chalk.yellow('⟳ processing')
        : chalk.dim('✓ queue clear');
      const depthNote = depth > 0 ? chalk.dim(` (${depth} queued)`) : '';
      return `${timestamp()} ${label}${depthNote}`;
    }

    case 'session_started': {
      const sessionId = data.content_session_id ?? data.session_id ?? '';
      const project = typeof data.project === 'string' ? data.project : '';
      const line1 = `${timestamp()} ${chalk.green('▶')} ${chalk.bold('session started')}${sessionId ? chalk.dim(` ${sessionId}`) : ''}`;
      const line2 = project ? chalk.dim(`            project: ${project}`) : '';
      return line2 ? `${line1}\n${line2}` : line1;
    }

    case 'session_completed': {
      const sessionId = data.content_session_id ?? data.session_id ?? '';
      const project = typeof data.project === 'string' ? data.project : '';
      const line1 = `${timestamp()} ${chalk.green('■')} ${chalk.bold('session completed')}${sessionId ? chalk.dim(` ${sessionId}`) : ''}`;
      const line2 = project ? chalk.dim(`            project: ${project}`) : '';
      return line2 ? `${line1}\n${line2}` : line1;
    }

    case 'prompt_saved': {
      const project = typeof data.project === 'string' ? data.project : '';
      const promptNum = typeof data.prompt_number === 'number' ? data.prompt_number : undefined;
      const label = promptNum !== undefined
        ? `prompt #${promptNum} saved`
        : 'prompt saved';
      const line1 = `${timestamp()} ${chalk.blue('❯')} ${chalk.bold(label)}`;
      const line2 = project ? chalk.dim(`            project: ${project}`) : '';
      return line2 ? `${line1}\n${line2}` : line1;
    }

    case 'observation_queued': {
      const project = typeof data.project === 'string' ? data.project : '';
      const line1 = `${timestamp()} ${chalk.dim('○')} observation queued`;
      const line2 = project ? chalk.dim(`            project: ${project}`) : '';
      return line2 ? `${line1}\n${line2}` : line1;
    }

    default:
      // Skip unknown event types to stay noise-free
      return null;
  }
}
