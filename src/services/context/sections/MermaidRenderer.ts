import type { Observation, SessionSummary } from '../types.js';
import { parseJsonArray } from '../../../shared/timeline-formatting.js';

const TYPE_STYLES: Record<string, { fill: string; color: string; emoji: string }> = {
  bugfix:    { fill: '#fed7d7', color: '#1a202c', emoji: '🔴' },
  feature:   { fill: '#e9d8fd', color: '#1a202c', emoji: '🟣' },
  refactor:  { fill: '#fef9c3', color: '#1a202c', emoji: '🔄' },
  change:    { fill: '#dcfce7', color: '#1a202c', emoji: '✅' },
  discovery: { fill: '#dbeafe', color: '#1a202c', emoji: '🔵' },
  decision:  { fill: '#ffedd5', color: '#1a202c', emoji: '⚖️' },
};

const DEFAULT_STYLE = { fill: '#f1f5f9', color: '#1a202c', emoji: '📌' };

function sanitize(text: string): string {
  return text
    .replace(/"/g, "'");
    .replace(/\n/g, ' ')
    .replace(/[<>{}|]/g, ' ')
    .trim()
    .slice(0, 60);
}

function extractPrimaryFile(filesJson: string | null): string {
  if (!filesJson) return '';
  try {
    const files = parseJsonArray(filesJson);
    if (files.length === 0) return '';
    const file = files[0];
    const parts = file.split('/');
    return parts.slice(-2).join('/');
  } catch {
    return '';
  }
}

function buildNode(obs: Observation, index: number): { id: string; line: string; style: string } {
  const style = TYPE_STYLES[obs.type] ?? DEFAULT_STYLE;
  const id = `N${index}`;
  const title = sanitize(obs.title ?? obs.subtitle ?? obs.type);
  const file = extractPrimaryFile(obs.files_modified ?? obs.files_read);
  const label = file ? `${style.emoji} ${title} · ${file}` : `${style.emoji} ${title}`;

  return {
    id,
    line: `    ${id}["${label}"]`,
    style: `    style ${id} fill:${style.fill},color:${style.color}`,
  };
}

/**
 * Renders a compact Mermaid task-flow diagram from the observations in the
 * most recent session.  Only enabled when CLAUDE_MEM_MERMAID_CONTEXT=true.
 *
 * Why Mermaid?  A session with 10 observations costs ~1,500-5,000 tokens when
 * rendered as prose.  The same information as a graph costs ~150-300 tokens --
 * roughly a 10x reduction -- while preserving the causal sequence and file
 * context the model needs to resume work accurately.
 */
export function renderMermaidFlow(
  observations: Observation[],
  summary: SessionSummary | undefined,
): string[] {
  if (observations.length === 0) return [];

  // Show only the most-recent session to keep the diagram tight.
  const latestSessionId = observations[0].memory_session_id;
  const sessionObs = observations
    .filter(o => o.memory_session_id === latestSessionId)
    .reverse(); // chronological order

  if (sessionObs.length === 0) return [];

  // Only use next_steps from the summary that belongs to this session.
  // summaries[0] may come from a different session if this session produced no summary.
  const sessionSummary = summary?.memory_session_id === latestSessionId ? summary : undefined;

  const nodes = sessionObs.map((obs, i) => buildNode(obs, i));

  const lines: string[] = [];
  lines.push('## Task Flow (Last Session)');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph LR');

  // Node declarations
  for (const node of nodes) {
    lines.push(node.line);
  }

  // Sequential edges
  for (let i = 0; i < nodes.length - 1; i++) {
    lines.push(`    ${nodes[i].id} --> ${nodes[i + 1].id}`);
  }

  // Optional: next_steps terminal node from the session summary
  if (sessionSummary?.next_steps && sessionSummary.next_steps.trim()) {
    const nextStepsText = sanitize(sessionSummary.next_steps);
    lines.push(`    NEXT(["Next: ${nextStepsText}"])`);
    lines.push(`    ${nodes[nodes.length - 1].id} --> NEXT`);
    lines.push('    style NEXT fill:#bee3f8,color:#1a202c');
  }

  // Node styles
  for (const node of nodes) {
    lines.push(node.style);
  }

  lines.push('```');
  lines.push('');

  return lines;
}
