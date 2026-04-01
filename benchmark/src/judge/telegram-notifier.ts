import type { AgentState } from './state-reader.js';
import type { DriftAssessment, DriftScore } from './drift-evaluator.js';

// --- Error Classes ---

export class TelegramSendError extends Error {
  constructor(public readonly reason: string) {
    super(`Failed to send Telegram message: ${reason}`);
    this.name = 'TelegramSendError';
  }
}

export class TelegramApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
  ) {
    super(
      `Telegram API returned ${statusCode}: ${responseBody}`,
    );
    this.name = 'TelegramApiError';
  }
}

// --- Escalation ---

export type EscalationTier = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Determines the escalation tier for an agent based on its drift assessment and state.
 *
 * - INFO: on-track, cost < 2x expected
 * - WARNING: drift detected OR cost > 2x expected
 * - CRITICAL: stuck/looping (no file changes in 30+ min while running)
 */
export function determineEscalationTier(
  assessment: DriftAssessment,
  agentState: AgentState,
): EscalationTier {
  // CRITICAL: stuck/looping -- no file changes in 30+ min while running
  if (
    agentState.containerStatus === 'running' &&
    assessment.lastActivityMinutesAgo >= 30
  ) {
    return 'CRITICAL';
  }

  // WARNING: any drift detected
  if (
    assessment.score === 'minor-deviation' ||
    assessment.score === 'major-drift' ||
    assessment.score === 'unrecoverable'
  ) {
    return 'WARNING';
  }

  return 'INFO';
}

function escalationEmoji(tier: EscalationTier): string {
  switch (tier) {
    case 'INFO':
      return '\u2139\uFE0F';
    case 'WARNING':
      return '\u26A0\uFE0F';
    case 'CRITICAL':
      return '\uD83D\uDED1';
  }
}

function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// --- Notifier ---

export class TelegramNotifier {
  private readonly apiBaseUrl: string;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {
    this.apiBaseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  /**
   * Sends a plain text message via Telegram Bot API.
   */
  async sendMessage(text: string, parseMode: string = 'Markdown'): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
        }),
      });
    } catch (error) {
      throw new TelegramSendError(
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new TelegramApiError(response.status, body);
    }
  }

  /**
   * Sends a judge cycle summary to Telegram.
   */
  async sendCycleSummary(
    cycleNumber: number,
    elapsed: string,
    states: AgentState[],
    assessments: DriftAssessment[],
  ): Promise<void> {
    const assessmentMap = new Map<string, DriftAssessment>();
    for (const assessment of assessments) {
      assessmentMap.set(assessment.agentId, assessment);
    }

    // Aggregate stats
    const runningCount = states.filter(
      (s) => !s.isDone && !s.isCrashed && !s.isKilled,
    ).length;
    const doneCount = states.filter((s) => s.isDone).length;
    const crashedCount = states.filter(
      (s) => s.isCrashed || s.isKilled,
    ).length;
    const totalCost = states.reduce((sum, s) => sum + s.estimatedCostUsd, 0);

    // Build per-agent lines, sorted by escalation tier (CRITICAL first, then WARNING, then INFO)
    const agentLines: { tier: EscalationTier; line: string; score: DriftScore }[] = [];

    for (const agentState of states) {
      const assessment = assessmentMap.get(agentState.agentId);
      if (!assessment) continue;

      const tier = determineEscalationTier(assessment, agentState);
      const emoji = escalationEmoji(tier);
      const costStr = `$${agentState.estimatedCostUsd.toFixed(2)}`;
      const elapsedStr = formatElapsed(agentState.elapsedSeconds);

      const line = `${emoji} ${tier}: ${agentState.agentId} — ${assessment.score}, ${costStr}, ${elapsedStr}`;
      agentLines.push({ tier, line, score: assessment.score });
    }

    // Sort: CRITICAL > WARNING > INFO
    const tierOrder: Record<EscalationTier, number> = {
      CRITICAL: 0,
      WARNING: 1,
      INFO: 2,
    };
    agentLines.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

    // Build message
    const lines: string[] = [
      `*Judge Cycle #${cycleNumber}* (elapsed: ${elapsed})`,
      '',
      `Running: ${runningCount} | Done: ${doneCount} | Crashed: ${crashedCount}`,
      `Total cost: $${totalCost.toFixed(2)}`,
      '',
    ];

    for (const entry of agentLines) {
      lines.push(entry.line);
    }

    // Add help commands
    lines.push('');
    lines.push('/kill {agent\\_id} \\u2014 to terminate');
    lines.push('/status \\u2014 full breakdown');

    await this.sendMessage(lines.join('\n'));
  }
}
