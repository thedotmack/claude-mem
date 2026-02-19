import React from 'react';
import type { ParsedLogLine } from './LogsModal';

// Configuration for log levels
const LOG_LEVEL_COLORS: Record<string, string> = {
  DEBUG: '#8b8b8b',
  INFO: '#58a6ff',
  WARN: '#d29922',
  ERROR: '#f85149',
};

const LOG_LEVEL_ICONS: Record<string, string> = {
  DEBUG: '🔍',
  INFO: 'ℹ️',
  WARN: '⚠️',
  ERROR: '❌',
};

const LOG_COMPONENT_COLORS: Record<string, string> = {
  HOOK: '#a371f7',
  WORKER: '#58a6ff',
  SDK: '#3fb950',
  PARSER: '#79c0ff',
  DB: '#f0883e',
  SYSTEM: '#8b949e',
  HTTP: '#39d353',
  SESSION: '#db61a2',
  CHROMA: '#a855f7',
};

const LOG_COMPONENT_ICONS: Record<string, string> = {
  HOOK: '🪝',
  WORKER: '⚙️',
  SDK: '📦',
  PARSER: '📄',
  DB: '🗄️',
  SYSTEM: '💻',
  HTTP: '🌐',
  SESSION: '📋',
  CHROMA: '🔮',
};

function getLineStyle(line: ParsedLogLine): React.CSSProperties {
  let color = 'var(--color-text-primary)';
  let backgroundColor = 'transparent';

  if (line.level === 'ERROR') {
    color = '#f85149';
    backgroundColor = 'rgba(248, 81, 73, 0.1)';
  } else if (line.level === 'WARN') {
    color = '#d29922';
    backgroundColor = 'rgba(210, 153, 34, 0.05)';
  } else if (line.isSpecial === 'success') {
    color = '#3fb950';
  } else if (line.isSpecial === 'failure') {
    color = '#f85149';
  } else if (line.isSpecial === 'happyPath') {
    color = '#d29922';
  } else if (line.level) {
    color = LOG_LEVEL_COLORS[line.level] ?? color;
  }

  return { color, backgroundColor, padding: '1px 0', borderRadius: '2px' };
}

interface LogLineProps {
  line: ParsedLogLine;
}

export function LogLine({ line }: LogLineProps): React.ReactElement {
  if (!line.timestamp) {
    return (
      <div className="log-line log-line-raw">
        {line.raw}
      </div>
    );
  }

  const levelColor = line.level ? LOG_LEVEL_COLORS[line.level] : undefined;
  const levelIcon = line.level ? LOG_LEVEL_ICONS[line.level] : '';
  const componentColor = line.component ? LOG_COMPONENT_COLORS[line.component] : undefined;
  const componentIcon = line.component ? LOG_COMPONENT_ICONS[line.component] : '';

  return (
    <div className="log-line" style={getLineStyle(line)}>
      <span className="log-timestamp">[{line.timestamp}]</span>
      {' '}
      <span className="log-level" style={{ color: levelColor }} title={line.level}>
        [{levelIcon} {line.level?.padEnd(5)}]
      </span>
      {' '}
      <span className="log-component" style={{ color: componentColor }} title={line.component}>
        [{componentIcon} {line.component?.padEnd(7)}]
      </span>
      {' '}
      {line.correlationId && (
        <>
          <span className="log-correlation">[{line.correlationId}]</span>
          {' '}
        </>
      )}
      <span className="log-message">{line.message}</span>
    </div>
  );
}
