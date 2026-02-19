import React, { useCallback } from 'react';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogComponent = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA';

interface FilterConfig {
  key: string;
  label: string;
  icon: string;
  color: string;
}

export const LOG_LEVELS: FilterConfig[] = [
  { key: 'DEBUG', label: 'Debug', icon: '🔍', color: '#8b8b8b' },
  { key: 'INFO', label: 'Info', icon: 'ℹ️', color: '#58a6ff' },
  { key: 'WARN', label: 'Warn', icon: '⚠️', color: '#d29922' },
  { key: 'ERROR', label: 'Error', icon: '❌', color: '#f85149' },
];

export const LOG_COMPONENTS: FilterConfig[] = [
  { key: 'HOOK', label: 'Hook', icon: '🪝', color: '#a371f7' },
  { key: 'WORKER', label: 'Worker', icon: '⚙️', color: '#58a6ff' },
  { key: 'SDK', label: 'SDK', icon: '📦', color: '#3fb950' },
  { key: 'PARSER', label: 'Parser', icon: '📄', color: '#79c0ff' },
  { key: 'DB', label: 'DB', icon: '🗄️', color: '#f0883e' },
  { key: 'SYSTEM', label: 'System', icon: '💻', color: '#8b949e' },
  { key: 'HTTP', label: 'HTTP', icon: '🌐', color: '#39d353' },
  { key: 'SESSION', label: 'Session', icon: '📋', color: '#db61a2' },
  { key: 'CHROMA', label: 'Chroma', icon: '🔮', color: '#a855f7' },
];

function toggleSetMember<T>(set: Set<T>, member: T): Set<T> {
  const next = new Set(set);
  if (next.has(member)) {
    next.delete(member);
  } else {
    next.add(member);
  }
  return next;
}

interface FilterChipGroupProps {
  label: string;
  items: FilterConfig[];
  activeKeys: Set<string>;
  onToggle: (key: string) => void;
  onToggleAll: (enabled: boolean) => void;
}

function FilterChipGroup({ label, items, activeKeys, onToggle, onToggleAll }: FilterChipGroupProps) {
  return (
    <div className="console-filter-section">
      <span className="console-filter-label">{label}:</span>
      <div className="console-filter-chips">
        {items.map(item => (
          <button
            key={item.key}
            className={`console-filter-chip ${activeKeys.has(item.key) ? 'active' : ''}`}
            onClick={() => { onToggle(item.key); }}
            style={{ '--chip-color': item.color } as React.CSSProperties}
            title={item.label}
          >
            {item.icon} {item.label}
          </button>
        ))}
        <button
          className="console-filter-action"
          onClick={() => { onToggleAll(activeKeys.size === 0); }}
          title={activeKeys.size === items.length ? 'Select none' : 'Select all'}
        >
          {activeKeys.size === items.length ? '○' : '●'}
        </button>
      </div>
    </div>
  );
}

interface LogFilterBarProps {
  activeLevels: Set<LogLevel>;
  activeComponents: Set<LogComponent>;
  alignmentOnly: boolean;
  onActiveLevelsChange: (levels: Set<LogLevel>) => void;
  onActiveComponentsChange: (components: Set<LogComponent>) => void;
  onAlignmentOnlyChange: (value: boolean) => void;
}

export function LogFilterBar({
  activeLevels,
  activeComponents,
  alignmentOnly,
  onActiveLevelsChange,
  onActiveComponentsChange,
  onAlignmentOnlyChange,
}: LogFilterBarProps): React.ReactElement {
  const toggleLevel = useCallback((key: string) => {
    onActiveLevelsChange(toggleSetMember(activeLevels, key as LogLevel));
  }, [activeLevels, onActiveLevelsChange]);

  const toggleComponent = useCallback((key: string) => {
    onActiveComponentsChange(toggleSetMember(activeComponents, key as LogComponent));
  }, [activeComponents, onActiveComponentsChange]);

  const setAllLevels = useCallback((enabled: boolean) => {
    onActiveLevelsChange(
      enabled ? new Set(LOG_LEVELS.map(l => l.key) as LogLevel[]) : new Set(),
    );
  }, [onActiveLevelsChange]);

  const setAllComponents = useCallback((enabled: boolean) => {
    onActiveComponentsChange(
      enabled ? new Set(LOG_COMPONENTS.map(c => c.key) as LogComponent[]) : new Set(),
    );
  }, [onActiveComponentsChange]);

  return (
    <div className="console-filters">
      <div className="console-filter-section">
        <span className="console-filter-label">Quick:</span>
        <div className="console-filter-chips">
          <button
            className={`console-filter-chip ${alignmentOnly ? 'active' : ''}`}
            onClick={() => { onAlignmentOnlyChange(!alignmentOnly); }}
            style={{ '--chip-color': '#f0883e' } as React.CSSProperties}
            title="Show only session alignment logs"
          >
            🔗 Alignment
          </button>
        </div>
      </div>
      <FilterChipGroup
        label="Levels"
        items={LOG_LEVELS}
        activeKeys={activeLevels as Set<string>}
        onToggle={toggleLevel}
        onToggleAll={setAllLevels}
      />
      <FilterChipGroup
        label="Components"
        items={LOG_COMPONENTS}
        activeKeys={activeComponents as Set<string>}
        onToggle={toggleComponent}
        onToggleAll={setAllComponents}
      />
    </div>
  );
}
