import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerManager } from '../container-manager.js';
import type { AgentState } from './state-reader.js';
import type { DriftAssessment } from './drift-evaluator.js';

// --- Error Classes ---

export class TelegramPollError extends Error {
  constructor(public readonly reason: string) {
    super(`Failed to poll Telegram for commands: ${reason}`);
    this.name = 'TelegramPollError';
  }
}

export class KillError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly reason: string,
  ) {
    super(`Failed to kill agent ${agentId}: ${reason}`);
    this.name = 'KillError';
  }
}

// --- Telegram Update Types ---

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id: number;
    };
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

// --- Kill Handler ---

export class KillHandler {
  private lastUpdateId: number = 0;
  private readonly apiBaseUrl: string;

  /** Callback to send a response message back to Telegram */
  private sendMessage: (text: string) => Promise<void>;

  /** Externally injectable state/assessment data for /status and /cost commands */
  private currentStates: AgentState[] = [];
  private currentAssessments: DriftAssessment[] = [];

  constructor(
    private readonly botToken: string,
    private readonly containerManager: ContainerManager,
    private readonly resultsDir: string,
    private readonly chatId: string,
  ) {
    this.apiBaseUrl = `https://api.telegram.org/bot${botToken}`;
    this.sendMessage = async (text: string) => {
      await fetch(`${this.apiBaseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
        }),
      });
    };
  }

  /**
   * Updates the handler's snapshot of current states and assessments.
   * Called by the judge runner each cycle before polling commands.
   */
  updateStateSnapshot(
    states: AgentState[],
    assessments: DriftAssessment[],
  ): void {
    this.currentStates = states;
    this.currentAssessments = assessments;
  }

  /**
   * Polls Telegram for new messages and processes recognized commands.
   *
   * Commands:
   * - /kill {agent_id} — stops container, writes KILLED.md
   * - /status — sends full agent status breakdown
   * - /cost — sends per-agent cost breakdown
   */
  async pollCommands(): Promise<void> {
    let updates: TelegramUpdate[];
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=0`,
      );

      if (!response.ok) {
        const body = await response.text();
        throw new TelegramPollError(
          `Telegram API returned ${response.status}: ${body}`,
        );
      }

      const data = (await response.json()) as TelegramGetUpdatesResponse;
      if (!data.ok) {
        throw new TelegramPollError('Telegram API returned ok=false');
      }

      updates = data.result;
    } catch (error) {
      if (error instanceof TelegramPollError) throw error;
      throw new TelegramPollError(
        error instanceof Error ? error.message : String(error),
      );
    }

    for (const update of updates) {
      this.lastUpdateId = update.update_id;

      const text = update.message?.text?.trim();
      if (!text) continue;

      if (text.startsWith('/kill ')) {
        const agentId = text.slice('/kill '.length).trim();
        await this.handleKill(agentId);
      } else if (text === '/status') {
        await this.handleStatus();
      } else if (text === '/cost') {
        await this.handleCost();
      }
    }
  }

  /**
   * Handles /kill {agent_id}: stops the container and writes KILLED.md.
   */
  private async handleKill(agentId: string): Promise<void> {
    try {
      // Find the agent in current states to get container info
      const agentState = this.currentStates.find(
        (s) => s.agentId === agentId,
      );

      if (!agentState) {
        await this.sendMessage(`Agent \`${agentId}\` not found in current manifest.`);
        return;
      }

      if (agentState.isDone || agentState.isCrashed || agentState.isKilled) {
        await this.sendMessage(
          `Agent \`${agentId}\` is already terminated (done=${agentState.isDone}, crashed=${agentState.isCrashed}, killed=${agentState.isKilled}).`,
        );
        return;
      }

      // Write KILLED.md first
      const killedPath = join(this.resultsDir, agentId, 'KILLED.md');
      await writeFile(
        killedPath,
        `# Killed\n\nKilled by operator via Telegram at ${new Date().toISOString()}\n`,
      );

      await this.sendMessage(
        `Agent \`${agentId}\` killed. KILLED.md written to results.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new KillError(agentId, reason);
    }
  }

  /**
   * Handles /status: sends a full breakdown of all agents.
   */
  private async handleStatus(): Promise<void> {
    if (this.currentStates.length === 0) {
      await this.sendMessage('No agent state data available yet.');
      return;
    }

    const assessmentMap = new Map<string, DriftAssessment>();
    for (const assessment of this.currentAssessments) {
      assessmentMap.set(assessment.agentId, assessment);
    }

    const lines: string[] = ['*Full Agent Status*', ''];

    for (const state of this.currentStates) {
      const assessment = assessmentMap.get(state.agentId);
      const status = state.isDone
        ? 'DONE'
        : state.isCrashed
          ? 'CRASHED'
          : state.isKilled
            ? 'KILLED'
            : 'RUNNING';
      const driftStr = assessment ? assessment.score : 'unknown';
      const costStr = `$${state.estimatedCostUsd.toFixed(2)}`;
      const elapsedMin = Math.round(state.elapsedSeconds / 60);

      lines.push(
        `\`${state.agentId}\` | ${status} | ${driftStr} | ${costStr} | ${elapsedMin}m | ${state.fileCount} files`,
      );
    }

    await this.sendMessage(lines.join('\n'));
  }

  /**
   * Handles /cost: sends a per-agent cost breakdown.
   */
  private async handleCost(): Promise<void> {
    if (this.currentStates.length === 0) {
      await this.sendMessage('No agent state data available yet.');
      return;
    }

    const totalCost = this.currentStates.reduce(
      (sum, s) => sum + s.estimatedCostUsd,
      0,
    );

    const lines: string[] = [
      `*Cost Breakdown* (Total: $${totalCost.toFixed(2)})`,
      '',
    ];

    // Sort by cost descending
    const sortedStates = [...this.currentStates].sort(
      (a, b) => b.estimatedCostUsd - a.estimatedCostUsd,
    );

    for (const state of sortedStates) {
      const costStr = `$${state.estimatedCostUsd.toFixed(2)}`;
      const tokens = state.tokenUsage
        ? `${state.tokenUsage.totalTokens.toLocaleString()} tokens`
        : 'no data';
      lines.push(`\`${state.agentId}\` | ${costStr} | ${tokens}`);
    }

    await this.sendMessage(lines.join('\n'));
  }
}
