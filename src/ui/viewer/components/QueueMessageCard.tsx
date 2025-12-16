import React, { useState, useMemo, useEffect } from 'react';
import type { QueueMessage } from '../types';

interface QueueMessageCardProps {
  message: QueueMessage;
  position: number;
  totalCount: number;
  onRetry: (id: number) => void;
  onAbort: (id: number) => void;
  onForceRestartSession: (sessionId: number) => void;
  onRecoverSession: (sessionId: number) => void;
}

/**
 * Extract filename from a file path
 */
function getFilename(filePath: string): string {
  // Handle both Windows and Unix paths
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Get icon for tool type
 */
function getToolIcon(toolName: string | null): string {
  const tool = toolName?.toLowerCase() || '';
  switch (tool) {
    case 'read': return '\uD83D\uDCD6'; // 📖
    case 'edit': return '\u270F\uFE0F'; // ✏️
    case 'write': return '\uD83D\uDCDD'; // 📝
    case 'grep': return '\uD83D\uDD0D'; // 🔍
    case 'glob': return '\uD83D\uDCC2'; // 📂
    case 'bash': return '\u26A1'; // ⚡
    case 'webfetch': return '\uD83C\uDF10'; // 🌐
    case 'websearch': return '\uD83D\uDD0E'; // 🔎
    case 'task': return '\uD83E\uDD16'; // 🤖
    default: return '\u2699\uFE0F'; // ⚙️
  }
}

/**
 * Safely parse JSON, handles double-encoded strings
 * Returns null on failure
 */
function safeJsonParse(str: string | null): any {
  if (!str) return null;
  try {
    let parsed = JSON.parse(str);
    // Handle double-encoded JSON (string containing JSON)
    if (typeof parsed === 'string' && (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        // Not double-encoded, use as-is
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse tool input and generate a human-readable summary
 */
function parseToolSummary(toolName: string | null, toolInput: string | null): { summary: string; fullPath?: string } {
  const parsed = safeJsonParse(toolInput);
  const tool = toolName?.toLowerCase() || '';

  // If we have parsed data, extract useful info
  if (parsed) {
    // Read tool - show filename
    if (tool === 'read' && parsed.file_path) {
      return {
        summary: `${getFilename(parsed.file_path)}`,
        fullPath: parsed.file_path
      };
    }

    // Grep tool - show pattern and scope
    if (tool === 'grep' && parsed.pattern) {
      const scope = parsed.path ? getFilename(parsed.path) : parsed.glob || 'codebase';
      return {
        summary: `"${parsed.pattern}" in ${scope}`,
        fullPath: parsed.path
      };
    }

    // Glob tool - show pattern
    if (tool === 'glob' && parsed.pattern) {
      return {
        summary: `${parsed.pattern}`,
        fullPath: parsed.path
      };
    }

    // Bash tool - show command (truncated)
    if (tool === 'bash' && parsed.command) {
      const cmd = parsed.command.length > 50
        ? parsed.command.slice(0, 47) + '...'
        : parsed.command;
      return { summary: cmd };
    }

    // Edit tool - show file being edited
    if (tool === 'edit' && parsed.file_path) {
      return {
        summary: `${getFilename(parsed.file_path)}`,
        fullPath: parsed.file_path
      };
    }

    // Write tool - show file being written
    if (tool === 'write' && parsed.file_path) {
      return {
        summary: `${getFilename(parsed.file_path)}`,
        fullPath: parsed.file_path
      };
    }

    // WebFetch - show URL domain
    if (tool === 'webfetch' && parsed.url) {
      try {
        const url = new URL(parsed.url);
        return { summary: `${url.hostname}${url.pathname.slice(0, 25)}` };
      } catch {
        return { summary: parsed.url.slice(0, 40) };
      }
    }

    // WebSearch - show query
    if (tool === 'websearch' && parsed.query) {
      return { summary: `"${parsed.query}"` };
    }

    // Task tool - show description
    if (tool === 'task' && parsed.description) {
      return { summary: parsed.description };
    }

    // TodoWrite - summarize
    if (tool === 'todowrite') {
      const count = Array.isArray(parsed.todos) ? parsed.todos.length : 0;
      return { summary: `${count} items` };
    }

    // Fallback: show file_path or command if available
    if (parsed.file_path) {
      return {
        summary: getFilename(parsed.file_path),
        fullPath: parsed.file_path
      };
    }

    if (parsed.command) {
      return { summary: parsed.command.slice(0, 40) + '...' };
    }
  }

  // Generic fallback - show tool name or unknown
  return { summary: toolName || 'Unknown' };
}

/**
 * Extract a content preview from tool_response
 */
function getContentPreview(toolResponse: string | null, maxLength: number = 80): string | null {
  const parsed = safeJsonParse(toolResponse);
  if (!parsed) return null;

  // Try to get a meaningful preview string
  let content: string | null = null;

  if (typeof parsed === 'string') {
    content = parsed;
  } else if (parsed.file?.content) {
    // Read tool response: {type: "text", file: {filePath, content}}
    content = parsed.file.content;
  } else if (parsed.content) {
    content = typeof parsed.content === 'string' ? parsed.content : null;
  } else if (parsed.output) {
    content = typeof parsed.output === 'string' ? parsed.output : null;
  } else if (parsed.text) {
    content = typeof parsed.text === 'string' ? parsed.text : null;
  } else if (parsed.stdout) {
    // Bash response
    content = parsed.stdout;
  } else if (parsed.matches && Array.isArray(parsed.matches)) {
    // Grep response
    content = `${parsed.matches.length} matches found`;
  }

  if (!content) return null;

  // Clean and truncate - preserve some structure
  content = content
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' \u00B7 ') // Replace newlines with middle dot
    .replace(/\s+/g, ' ')
    .trim();

  if (content.length > maxLength) {
    return content.slice(0, maxLength - 3) + '...';
  }
  return content;
}

export function QueueMessageCard({ message, position, totalCount, onRetry, onAbort, onForceRestartSession, onRecoverSession }: QueueMessageCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Force re-render every second to update age-based displays
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const statusInfo = useMemo(() => {
    if (message.isStuck) {
      return { color: '#ef4444', label: 'Stuck', icon: '!' };
    }
    switch (message.status) {
      case 'pending':
        return { color: '#eab308', label: 'Pending', icon: '\u25CF' };
      case 'processing':
        return { color: '#3b82f6', label: 'Processing', icon: '\u25CF' };
      case 'failed':
        return { color: '#ef4444', label: 'Failed', icon: '\u25CF' };
      default:
        return { color: '#6b7280', label: message.status, icon: '\u25CF' };
    }
  }, [message.status, message.isStuck]);

  const toolIcon = useMemo(() => getToolIcon(message.tool_name), [message.tool_name]);

  const toolSummary = useMemo(() => {
    return parseToolSummary(message.tool_name, message.tool_input);
  }, [message.tool_name, message.tool_input]);

  const contentPreview = useMemo(() => {
    return getContentPreview(message.tool_response);
  }, [message.tool_response]);

  // Calculate timing info and stuck status
  const timingInfo = useMemo(() => {
    const now = Date.now();
    const queuedAgo = formatDuration(now - message.created_at_epoch);
    const processingTimeMs = message.started_processing_at_epoch
      ? now - message.started_processing_at_epoch
      : 0;
    const processingTime = processingTimeMs > 0 ? formatDuration(processingTimeMs) : null;

    // Frontend stuck check (backup) - 2.5 minutes = 150000ms
    const isStuckLocal = message.status === 'processing' && processingTimeMs > 150000;

    return { queuedAgo, processingTime, isStuckLocal };
  }, [message.created_at_epoch, message.started_processing_at_epoch, message.status]);

  // Use either backend or frontend stuck detection
  const isEffectivelyStuck = message.isStuck || timingInfo.isStuckLocal;

  // Parse tool input for expanded view
  const parsedToolInput = useMemo(() => safeJsonParse(message.tool_input), [message.tool_input]);
  const parsedToolResponse = useMemo(() => safeJsonParse(message.tool_response), [message.tool_response]);

  return (
    <div className={`queue-message-card ${isEffectivelyStuck ? 'stuck' : ''}`}>
      {/* Header row: Status + Processing time */}
      <div className="queue-message-header">
        <span className="queue-status" style={{ color: isEffectivelyStuck ? '#ef4444' : statusInfo.color }}>
          {isEffectivelyStuck ? '!' : statusInfo.icon} {isEffectivelyStuck ? 'Stuck' : statusInfo.label}
        </span>
        <span className="queue-time">
          {timingInfo.processingTime || timingInfo.queuedAgo}
        </span>
      </div>

      {/* Main content: Tool icon + summary */}
      <div className="queue-message-summary">
        <span className="queue-tool-icon">{toolIcon}</span>
        <span className="queue-tool-name">{message.tool_name || 'Processing'}</span>
        <span className="queue-tool-target">{toolSummary.summary}</span>
      </div>

      {/* Content preview if available */}
      {contentPreview && (
        <div className="queue-content-preview">
          {contentPreview}
        </div>
      )}

      {/* Last user message context */}
      {message.last_user_message && (
        <div className="queue-user-context">
          Context: "{message.last_user_message.slice(0, 60)}{message.last_user_message.length > 60 ? '...' : ''}"
        </div>
      )}

      {/* Meta info: Project, Queue position and timing */}
      <div className="queue-message-meta">
        {message.project && (
          <>
            <span className="queue-project">{message.project}</span>
            <span className="queue-meta-separator">{'\u2022'}</span>
          </>
        )}
        <span>Queued {timingInfo.queuedAgo}</span>
        <span className="queue-meta-separator">{'\u2022'}</span>
        <span>#{position} of {totalCount}</span>
        {message.retry_count > 0 && (
          <>
            <span className="queue-meta-separator">{'\u2022'}</span>
            <span className="queue-retries">Retry {message.retry_count}/3</span>
          </>
        )}
      </div>

      {/* Agent status indicator - shows whether SDK agent is processing this session */}
      <div className={`queue-agent-status ${message.hasActiveAgent ? 'active' : 'no-agent'}`}>
        {message.hasActiveAgent ? (
          <span>{'\u26A1'} Agent active for session #{message.session_db_id}</span>
        ) : (
          <span>{'\u26A0'} No active agent for session #{message.session_db_id}</span>
        )}
      </div>

      {/* Action buttons */}
      <div className="queue-message-actions">
        <button
          className="queue-btn queue-btn-retry"
          onClick={() => onRetry(message.id)}
          title={
            isEffectivelyStuck ? 'Retry stuck message' :
            message.status === 'processing' ? 'Reset to pending' :
            message.status === 'failed' ? 'Retry failed message' :
            'Re-queue message'
          }
        >
          Retry
        </button>
        <button
          className="queue-btn queue-btn-abort"
          onClick={() => onAbort(message.id)}
          title="Remove from queue"
        >
          Abort
        </button>
        {/* Show Fix Session if no active agent */}
        {!message.hasActiveAgent && (
          <button
            className="queue-btn queue-btn-recover"
            onClick={() => onRecoverSession(message.session_db_id)}
            title="Start agent to process pending messages"
          >
            Fix Session
          </button>
        )}
        <button
          className="queue-btn queue-btn-expand"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '\u25B2 Collapse' : '\u25BC Details'}
        </button>
      </div>

      {/* Expanded details section */}
      {expanded && (
        <div className="queue-message-details">
          {message.project && (
            <div className="detail-row">
              <span className="detail-label">Project:</span>
              <span className="detail-value">{message.project}</span>
            </div>
          )}
          {toolSummary.fullPath && (
            <div className="detail-row">
              <span className="detail-label">Full Path:</span>
              <span className="detail-value detail-path">{toolSummary.fullPath}</span>
            </div>
          )}
          <div className="detail-row">
            <span className="detail-label">Message ID:</span>
            <span className="detail-value">{message.id}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Session:</span>
            <span className="detail-value">#{message.session_db_id}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Claude Session:</span>
            <span className="detail-value detail-uuid">{message.claude_session_id}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Created:</span>
            <span className="detail-value">{new Date(message.created_at_epoch).toLocaleString()}</span>
          </div>
          {message.started_processing_at_epoch && (
            <div className="detail-row">
              <span className="detail-label">Started:</span>
              <span className="detail-value">{new Date(message.started_processing_at_epoch).toLocaleString()}</span>
            </div>
          )}
          {parsedToolInput && (
            <div className="detail-section">
              <span className="detail-label">Tool Input:</span>
              <pre className="detail-json">
                {JSON.stringify(parsedToolInput, null, 2)}
              </pre>
            </div>
          )}
          {parsedToolResponse && (
            <div className="detail-section">
              <span className="detail-label">Tool Response (being processed):</span>
              <pre className="detail-json">
                {typeof parsedToolResponse === 'string'
                  ? parsedToolResponse.slice(0, 500) + (parsedToolResponse.length > 500 ? '...' : '')
                  : JSON.stringify(parsedToolResponse, null, 2).slice(0, 500)}
              </pre>
            </div>
          )}
          {message.last_user_message && (
            <div className="detail-section">
              <span className="detail-label">Last User Message:</span>
              <pre className="detail-json">{message.last_user_message}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
