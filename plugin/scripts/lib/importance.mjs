// Importance-Scoring + Auto-Pin Heuristics for observations.
// Spec: docs/sprint2/03-feature-gap-sota.md Quick-Wins #1 + #11.
//
// Heuristic-only — no LLM calls. The score is a 0..1 number that the retrieval
// path can use as a tiebreaker (BM25 × (0.5 + importance)). Auto-pin matches a
// small regex for ADR-style markers.

const PIN_PATTERNS = [
  /\bdecision:\s/i,
  /\bwe (use|chose|prefer)\s\w+\s(over|instead of|because)\b/i,
  /\b(adopted|migrated to|standardized on|deprecated)\s\w+/i,
  /\b(MUST|SHOULD) (use|not use|avoid)\s/i,
  /\bADR[-_ ]?\d+\b/i,
];

const FAILURE_INDICATORS = [
  /\b(error|fail(ed|ure)?|exception|panic|crashed?|denied|refused)\b/i,
  /\bexit ?code[:\s]+[1-9]/i,
  /\bnon-zero exit\b/i,
];

export function scoreImportance({
  toolKind,
  toolName,
  outcome,
  isExplicitUserAsk = false,
  isGitTracked = false,
  text = '',
} = {}) {
  let score = 0.3; // baseline
  if (outcome === 'failure') score += 0.4;
  if (isExplicitUserAsk) score += 0.2;
  if (toolKind === 'edit' && isGitTracked) score += 0.2;
  if (toolKind === 'read') score -= 0.1;
  if (toolName === 'Task' || toolName === 'Skill') score += 0.1; // subagent + skill = higher signal
  if (FAILURE_INDICATORS.some(re => re.test(text))) score += 0.15;
  return Math.max(0, Math.min(1, score));
}

export function shouldAutoPin(text = '') {
  if (!text) return false;
  return PIN_PATTERNS.some(re => re.test(text));
}

export function deriveToolKind(toolName) {
  if (!toolName) return 'unknown';
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return 'read';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'edit';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'webfetch';
  if (toolName === 'Task') return 'task';
  if (toolName === 'Skill') return 'skill';
  return 'unknown';
}

export function deriveOutcome(toolResponse) {
  if (!toolResponse) return 'unknown';
  if (typeof toolResponse !== 'object') return 'unknown';
  if (toolResponse.exitCode != null && toolResponse.exitCode !== 0) return 'failure';
  if (toolResponse.error) return 'failure';
  if (toolResponse.success === false) return 'failure';
  if (toolResponse.stdout != null || toolResponse.result != null || toolResponse.success === true) return 'success';
  return 'partial';
}
