/**
 * Claude-Mem StatusLine Hook
 *
 * Displays context usage indicator and observation count.
 * Inspired by Continuous Claude v2's StatusLine indicator.
 *
 * Usage: Configure in ~/.claude/settings.json:
 * {
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node /path/to/statusline-hook.js",
 *     "padding": 0
 *   }
 * }
 *
 * Input (via stdin): JSON with context_window, model, workspace, cost
 * Output (via stdout): Single line status text with ANSI colors
 */

import { stdin } from 'process';

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
};

interface StatusLineInput {
  session_id: string;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
  };
  cost?: {
    total_cost_usd: number;
    total_duration_ms: number;
  };
  context_window?: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
  };
}

/**
 * Get context usage indicator based on percentage
 */
function getContextIndicator(percentUsed: number): string {
  if (percentUsed < 60) {
    return `${COLORS.green}🟢${COLORS.reset}`;
  } else if (percentUsed < 80) {
    return `${COLORS.yellow}🟡${COLORS.reset}`;
  } else {
    return `${COLORS.red}🔴${COLORS.reset}`;
  }
}

/**
 * Calculate context usage percentage
 */
function calculateContextUsage(contextWindow: StatusLineInput['context_window']): number {
  if (!contextWindow || !contextWindow.current_usage) {
    return 0;
  }

  const { current_usage, context_window_size } = contextWindow;
  const totalTokens =
    current_usage.input_tokens +
    current_usage.cache_creation_input_tokens +
    current_usage.cache_read_input_tokens;

  return Math.round((totalTokens / context_window_size) * 100);
}

interface WorkerStats {
  observations: number | null;
  savings: number | null;
  savingsPercent: number | null;
}

interface SessionStats {
  observationsCount: number | null;
  totalTokens: number | null;
  promptsCount: number | null;
}

/**
 * Get stats from claude-mem worker (non-blocking)
 */
async function getWorkerStats(): Promise<WorkerStats> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500); // 500ms timeout

    const response = await fetch('http://127.0.0.1:37777/api/stats', {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return {
        observations: data.database?.observations ?? null,
        savings: data.savings?.current?.savings ?? null,
        savingsPercent: data.savings?.current?.savingsPercent ?? null
      };
    }
  } catch {
    // Worker not running or timeout - silently ignore
  }
  return { observations: null, savings: null, savingsPercent: null };
}

/**
 * Get session-specific stats from claude-mem worker (non-blocking)
 */
async function getSessionStats(sessionId: string | undefined): Promise<SessionStats> {
  if (!sessionId) {
    return { observationsCount: null, totalTokens: null, promptsCount: null };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500); // 500ms timeout

    const response = await fetch(`http://127.0.0.1:37777/api/session/${sessionId}/stats`, {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return {
        observationsCount: data.observationsCount ?? null,
        totalTokens: data.totalTokens ?? null,
        promptsCount: data.promptsCount ?? null
      };
    }
  } catch {
    // Worker not running or timeout - silently ignore
  }
  return { observationsCount: null, totalTokens: null, promptsCount: null };
}

/**
 * Format number with K/M suffix for compact display
 */
function formatCompact(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(0)}k`;
  }
  return num.toString();
}

/**
 * Format the statusline output
 */
async function formatStatusLine(input: StatusLineInput): Promise<string> {
  const parts: string[] = [];

  // Model indicator
  const modelName = input.model?.display_name || 'Claude';
  parts.push(`${COLORS.cyan}[${modelName}]${COLORS.reset}`);

  // Context usage indicator
  if (input.context_window) {
    const percentUsed = calculateContextUsage(input.context_window);
    const indicator = getContextIndicator(percentUsed);
    parts.push(`${indicator} ${percentUsed}%`);
  }

  // Fetch both global and session stats in parallel
  const [globalStats, sessionStats] = await Promise.all([
    getWorkerStats(),
    getSessionStats(input.session_id)
  ]);

  // Session-specific stats (this session)
  if (sessionStats.observationsCount !== null && sessionStats.observationsCount > 0) {
    const sessionTokensDisplay = sessionStats.totalTokens
      ? ` ${formatCompact(sessionStats.totalTokens)}t`
      : '';
    parts.push(`${COLORS.bold}📝 ${sessionStats.observationsCount}${sessionTokensDisplay}${COLORS.reset}`);
  }

  // Global stats (total observations)
  if (globalStats.observations !== null) {
    parts.push(`${COLORS.dim}${globalStats.observations} total${COLORS.reset}`);
  }

  // Cumulative savings (tokens saved from memory reuse)
  if (globalStats.savings !== null && globalStats.savings > 0) {
    const savingsDisplay = formatCompact(globalStats.savings);
    const percentDisplay = globalStats.savingsPercent !== null ? ` (${globalStats.savingsPercent}%)` : '';
    parts.push(`${COLORS.green}💰 ${savingsDisplay}t saved${percentDisplay}${COLORS.reset}`);
  }

  // Current directory (basename only)
  if (input.workspace?.current_dir) {
    const dirName = input.workspace.current_dir.split('/').pop() || '';
    parts.push(`${COLORS.dim}📁 ${dirName}${COLORS.reset}`);
  }

  // Cost (if available and non-zero)
  if (input.cost?.total_cost_usd && input.cost.total_cost_usd > 0) {
    const cost = input.cost.total_cost_usd.toFixed(4);
    parts.push(`${COLORS.dim}$${cost}${COLORS.reset}`);
  }

  return parts.join(' | ');
}

// Main entry point
async function main(): Promise<void> {
  let inputData = '';

  stdin.on('data', (chunk) => {
    inputData += chunk;
  });

  stdin.on('end', async () => {
    try {
      const input: StatusLineInput = inputData ? JSON.parse(inputData) : {};
      const statusLine = await formatStatusLine(input);
      console.log(statusLine);
    } catch (error) {
      // Fallback to simple status on error
      console.log(`${COLORS.cyan}[Claude-Mem]${COLORS.reset}`);
    }
  });
}

main().catch(() => {
  console.log('[Claude-Mem]');
});
