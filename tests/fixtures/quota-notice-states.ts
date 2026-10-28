import type { ObserverHealthState, ObserverQuotaNoticeContext, ObserverQuotaNoticeHold } from '../../src/shared/observer-health.js';

export const QUOTA_NOTICE_NOW = Date.parse('2026-10-27T20:15:00-07:00');
export const QUOTA_NOTICE_TIME_ZONE = 'America/Los_Angeles';
export const QUOTA_NOTICE_MODEL_LINE = "(Assistant: at the start of your first reply, tell the user in one sentence that claude-mem has paused saving memories and why. Don't restart the worker or suggest it.)";

const retryAt = Date.parse('2026-10-27T20:46:30-07:00');
const claudeGuard: ObserverQuotaNoticeHold = {
  provider: 'claude', displayName: 'your Claude plan', retryName: 'Claude', role: 'main',
  until: retryAt, auth: 'subscription',
  reason: { kind: 'limit_guard', window: 'five_hour', usagePercent: 95, thresholdPercent: 95 },
};
const gatewayOutage: ObserverQuotaNoticeHold = {
  provider: 'openrouter', displayName: 'cmem.ai', retryName: 'cmem.ai', role: 'main',
  until: Date.parse('2026-10-27T20:16:46-07:00'), reason: { kind: 'unavailable' },
};
const weeklyGuard: ObserverQuotaNoticeHold = {
  ...claudeGuard,
  reason: { kind: 'limit_guard', window: 'seven_day', usagePercent: 99, thresholdPercent: 93 },
};

function state(holds: ObserverQuotaNoticeHold[], context: Partial<ObserverQuotaNoticeContext> = {}): ObserverHealthState {
  const longest = holds.reduce((left, right) => left.until > right.until ? left : right);
  const main = holds.find(hold => hold.role === 'main');
  const backup = holds.find(hold => hold.role === 'backup');
  return {
    consecutiveFailures: 0, failingSinceAt: null, lastErrorAt: null,
    lastErrorMessage: null, lastErrorProvider: null, lastSuccessAt: QUOTA_NOTICE_NOW - 1_000,
    quotaCooldown: {
      active: true, provider: longest.provider, profile: 'default',
      armedAt: QUOTA_NOTICE_NOW - 10_000, until: longest.until, auth: longest.auth,
      reason: longest.reason, servingProvider: context.servingProvider,
      notice: {
        mainProvider: main?.provider ?? 'openrouter',
        mainDisplayName: main?.displayName ?? 'cmem.ai',
        mainRetryName: main?.retryName ?? 'cmem.ai',
        backupProvider: backup?.provider,
        backupDisplayName: backup?.displayName,
        defaultClaudeBackup: false,
        ...context, holds,
      },
    },
  };
}

export const QUOTA_NOTICE_CASES: Array<{ name: string; state: ObserverHealthState; expected: string }> = [
  {
    name: '1. cmem.ai unavailable; default Claude backup',
    state: state([gatewayOutage], {
      backupProvider: 'claude', backupDisplayName: 'your Claude plan', defaultClaudeBackup: true,
      servingProvider: 'claude', servingDisplayName: 'your Claude plan', servingAuth: 'subscription',
    }),
    expected: "ℹ️ claude-mem is using your Claude plan to save memories because cmem.ai isn't available. It switches back on its own and tries cmem.ai again at 8:17 PM. Nothing to do. (To stop using your Claude plan as a backup, set CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER=off.)",
  },
  {
    name: '1. Gemini quota; explicitly selected Claude backup',
    state: state([{ ...gatewayOutage, provider: 'gemini', displayName: 'Gemini', retryName: 'Gemini', until: Date.parse('2026-10-27T21:14:30-07:00'), reason: { kind: 'out_of_quota' } }], {
      backupProvider: 'claude', backupDisplayName: 'your Claude plan',
      servingProvider: 'claude', servingDisplayName: 'your Claude plan', servingAuth: 'subscription',
    }),
    expected: "ℹ️ claude-mem is using your Claude plan to save memories because Gemini says you're out of quota. It switches back on its own and tries Gemini again at 9:15 PM. Nothing to do.",
  },
  {
    name: '1. Claude reserve; OpenRouter backup',
    state: state([claudeGuard], { backupProvider: 'openrouter', backupDisplayName: 'OpenRouter', servingProvider: 'openrouter', servingDisplayName: 'OpenRouter' }),
    expected: "ℹ️ claude-mem is using OpenRouter to save memories because you've used 95% of your 5-hour Claude limit (claude-mem stops at 95% to leave the rest for you). It switches back on its own and tries Claude again at 8:47 PM. Nothing to do.",
  },
  {
    name: '2. Anthropic API key held; Claude Code login serving',
    state: state([{ ...claudeGuard, displayName: 'your Anthropic API key', retryName: 'your Anthropic API key', auth: 'api-key', reason: { kind: 'api_key_limit' } }], {
      servingProvider: 'claude', servingDisplayName: 'your Claude plan', servingAuth: 'subscription',
    }),
    expected: 'ℹ️ claude-mem is using your Claude Code login to save memories because your Anthropic API key has hit its credit or usage limit. It switches back to the key on its own and tries it again at 8:47 PM. Nothing to do.',
  },
  {
    name: '3. Claude Code login held; backup API key serving',
    state: state([weeklyGuard], { servingProvider: 'claude', servingDisplayName: 'your backup API key (ANTHROPIC_FALLBACK_API_KEY)', servingAuth: 'api-key' }),
    expected: "ℹ️ claude-mem is using your backup API key (ANTHROPIC_FALLBACK_API_KEY) to save memories because you've used 99% of your weekly Claude limit (claude-mem stops at 93% to leave the rest for you). That key is billed per request. It switches back to your login on its own and tries it again at 8:47 PM.",
  },
  {
    name: '4. Claude reserve; no different backup configured',
    state: state([claudeGuard], { backupProvider: 'claude', backupDisplayName: 'your Claude plan', defaultClaudeBackup: true }),
    expected: "⚠️ claude-mem has paused saving memories because you've used 95% of your 5-hour Claude limit (it stops at 95% to leave the rest for you). New activity is queued and saved when it resumes; it tries Claude again at 8:47 PM. You don't need to do anything, and restarting won't change it. (To keep saving through limits, pick a backup in CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER.)\n" + QUOTA_NOTICE_MODEL_LINE,
  },
  {
    name: '4. Gemini quota; configured backup cannot serve',
    state: state([{ ...gatewayOutage, provider: 'gemini', displayName: 'Gemini', retryName: 'Gemini', until: Date.parse('2026-10-27T21:14:30-07:00'), reason: { kind: 'out_of_quota' } }], {
      backupProvider: 'claude', backupDisplayName: 'your Claude plan',
    }),
    expected: "⚠️ claude-mem has paused saving memories because Gemini says you're out of quota. New activity is queued and saved when it resumes; it tries Gemini again at 9:15 PM. You don't need to do anything, and restarting won't change it.\n" + QUOTA_NOTICE_MODEL_LINE,
  },
  {
    name: '4. Busy provider; short hold',
    state: state([{ ...gatewayOutage, reason: { kind: 'busy' } }]),
    expected: '⚠️ claude-mem has paused saving memories because cmem.ai is busy (rate limited or over capacity). New activity is queued; it tries cmem.ai again at 8:17 PM.\n' + QUOTA_NOTICE_MODEL_LINE,
  },
  {
    name: '5. Main and backup held; earliest retry',
    state: state([
      { ...gatewayOutage, until: Date.parse('2026-10-27T20:49:00-07:00') },
      { ...weeklyGuard, role: 'backup' },
    ]),
    expected: "⚠️ claude-mem has paused saving memories because cmem.ai isn't available and its backup, your Claude plan, is paused (you've used 99% of your weekly Claude limit). New activity is queued and saved when either comes back; it tries again at 8:47 PM. You don't need to do anything, and restarting won't change it.\n" + QUOTA_NOTICE_MODEL_LINE,
  },
  {
    name: '6. Only backup held; cmem.ai serving',
    state: state([{ ...weeklyGuard, role: 'backup' }], {
      mainProvider: 'openrouter', mainDisplayName: 'cmem.ai', mainRetryName: 'cmem.ai',
      servingProvider: 'openrouter', servingDisplayName: 'cmem.ai',
    }),
    expected: '',
  },
  {
    name: '1. Non-Claude backup; main unavailable',
    state: state([gatewayOutage], { backupProvider: 'gemini', backupDisplayName: 'Gemini', servingProvider: 'gemini', servingDisplayName: 'Gemini' }),
    expected: "ℹ️ claude-mem is using Gemini to save memories because cmem.ai isn't available. It switches back on its own and tries cmem.ai again at 8:17 PM. Nothing to do.",
  },
  {
    name: '1. Claude reset-buffer guard; OpenRouter backup',
    state: state([{ ...claudeGuard, reason: { kind: 'reset_buffer_guard', window: 'five_hour', usagePercent: 89, resetsAt: Date.parse('2026-10-27T20:29:01-07:00') } }], {
      backupProvider: 'openrouter', backupDisplayName: 'OpenRouter', servingProvider: 'openrouter', servingDisplayName: 'OpenRouter',
    }),
    expected: "ℹ️ claude-mem is using OpenRouter to save memories because you've used 89% of your 5-hour Claude limit and it resets at 8:30 PM (claude-mem pauses in the last 15 minutes to leave the rest for you). It switches back on its own and tries Claude again at 8:47 PM. Nothing to do.",
  },
  {
    name: 'Old ledger; serving provider known, roles unknown',
    state: {
      ...state([claudeGuard]),
      quotaCooldown: { active: true, provider: 'claude', auth: 'subscription', armedAt: QUOTA_NOTICE_NOW, until: retryAt, window: 'seven_day', servingProvider: 'openrouter' },
    },
    expected: 'ℹ️ claude-mem is using OpenRouter to save memories while your Claude plan is on hold; it tries Claude again at 8:47 PM.',
  },
];
