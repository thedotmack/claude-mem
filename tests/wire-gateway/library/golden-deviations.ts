// Where a ported installer's bytes may differ from the pre-Library golden,
// and why (plan Phase 14 task 4: "every ported installer must reproduce the
// old outputs byte-for-byte", with the deviations the plan's own rules
// force). Anything not listed must match the golden exactly; a listed path
// must equal the recorded post-port bytes in library-golden/deviations.json.

export interface GoldenDeviationReason {
  scenario: RegExp;
  path: RegExp;
  reason: string;
}

export const GOLDEN_DEVIATION_REASONS: readonly GoldenDeviationReason[] = [
  {
    scenario: /^kimi-(existing|reinstall|uninstall)$/,
    path: /^home\/\.kimi-code\/config\.toml\.bak-<YYYYMMDD>$/,
    reason: 'Kimi\'s own day-stamped sibling backup is gone: the Library backs up every file it writes (task 3) under <DATA_DIR>/wire-gateway/library/backups, keeping the last 30 changes.',
  },
  {
    scenario: /^codex-existing$/,
    path: /^home\/\.codex\/config\.toml$/,
    reason: 'Codex TOML edits moved to the Phase 7 TOML editor (task 4), which adds a missing key at the end of its existing table; the old line setter put it right under the header. Same TOML value.',
  },
  {
    scenario: /^codex-uninstall$/,
    path: /^home\/\.codex\/config\.toml$/,
    reason: 'Uninstall takes out the settings claude-mem recorded (features.hooks, both plugin tables) instead of leaving `enabled = false` and `hooks = true` behind: never leave claude-mem\'s writes in a user config, restore what was there.',
  },
  {
    scenario: /^mcp-(fresh|existing)$/,
    path: /^home\/\.config\/goose\/config\.yaml$/,
    reason: 'Goose moved from the regex splice to the Phase 7 YAML editor (task 4): `args` is written as a flow sequence and a new extension is added after the existing ones. Bun.YAML parses both to the same value.',
  },
  {
    scenario: /^antigravity-uninstall$/,
    path: /^home\/\.gemini\/config\/hooks\.json$/,
    reason: 'Never remove unrecorded entries: the old uninstall deleted the whole `claude-mem` named hook, including a `Notification` handler claude-mem never wrote.',
  },
  {
    scenario: /^antigravity-uninstall$/,
    path: /^home\/\.gemini\/(GEMINI\.md|config\/mcp_config\.json)$/,
    reason: 'Uninstall restores the exact bytes (verification): GEMINI.md is back to its own bytes (the old remover added a final newline the user never had), and the 0-byte mcp_config.json is 0 bytes again instead of `{"mcpServers": {}}`.',
  },
  {
    scenario: /^openclaw-uninstall$/,
    path: /^home\/\.openclaw\/openclaw\.json$/,
    reason: 'Uninstall restores the exact bytes (verification): no empty `slots: {}` that claude-mem created is left behind.',
  },
];

export function deviationReasonFor(scenario: string, path: string): string | null {
  return GOLDEN_DEVIATION_REASONS.find((entry) => entry.scenario.test(scenario) && entry.path.test(path))?.reason ?? null;
}
