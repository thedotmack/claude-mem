import React, { useMemo } from 'react';
import { TokenUsageEvent } from '../types';

interface TokenCounterProps {
  tokenEvents: TokenUsageEvent[];
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number): string {
  if (usd === 0) return 'Free';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function TokenCounter({ tokenEvents }: TokenCounterProps) {
  const stats = useMemo(() => {
    let totalInput = 0, totalOutput = 0, totalCost = 0;
    const byProvider: Record<string, { input: number; output: number; cost: number; count: number }> = {};

    for (const e of tokenEvents) {
      totalInput += e.inputTokens;
      totalOutput += e.outputTokens;
      totalCost += e.estimatedCostUsd;

      const key = `${e.provider} (${e.model})`;
      if (!byProvider[key]) byProvider[key] = { input: 0, output: 0, cost: 0, count: 0 };
      byProvider[key].input += e.inputTokens;
      byProvider[key].output += e.outputTokens;
      byProvider[key].cost += e.estimatedCostUsd;
      byProvider[key].count++;
    }

    return { totalInput, totalOutput, totalCost, byProvider };
  }, [tokenEvents]);

  // Don't render anything when empty — saves space
  if (tokenEvents.length === 0) return null;

  return (
    <div style={{ padding: '10px 16px', background: 'var(--bg-secondary, #16213e)',
      borderRadius: '8px', border: '1px solid var(--border-color, #333)' }}>
      {/* Summary row */}
      <div style={{ display: 'flex', gap: '20px', alignItems: 'center', fontSize: '13px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: 'var(--text-secondary, #888)' }}>In:</span>
          <span style={{ color: '#60a5fa', fontWeight: 600, fontFamily: 'monospace' }}>{formatTokens(stats.totalInput)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: 'var(--text-secondary, #888)' }}>Out:</span>
          <span style={{ color: '#4ade80', fontWeight: 600, fontFamily: 'monospace' }}>{formatTokens(stats.totalOutput)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: 'var(--text-secondary, #888)' }}>Cost:</span>
          <span style={{ color: '#facc15', fontWeight: 600, fontFamily: 'monospace' }}>{formatCost(stats.totalCost)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ color: 'var(--text-secondary, #888)' }}>Calls:</span>
          <span style={{ color: 'var(--text-primary, #e0e0e0)', fontWeight: 600, fontFamily: 'monospace' }}>{tokenEvents.length}</span>
        </div>
      </div>

      {/* Per-provider breakdown */}
      {Object.keys(stats.byProvider).length > 1 && (
        <div style={{ marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {Object.entries(stats.byProvider).map(([key, data]) => (
            <span key={key} style={{
              fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
              background: 'var(--bg-primary, #1a1a2e)', color: 'var(--text-secondary, #aaa)',
              border: '1px solid var(--border-color, #333)'
            }}>
              {key}: {formatTokens(data.input + data.output)} ({formatCost(data.cost)})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
