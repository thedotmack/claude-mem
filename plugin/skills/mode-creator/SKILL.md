---
name: mode-creator
description: Interactively create, install, activate, and verify custom claude-mem modes, including domain-specific observation types, concept tags, optional Telegram alerts, bot setup, worker restart, and startup-context verification. Use this whenever someone asks to customize what claude-mem remembers, create or change a mode, track domain-specific notes, add observation types or tags, or send Telegram notifications for particular memories—even if they do not use the word "mode."
compatibility: Requires a local claude-mem worker installation, an interactive question tool, filesystem access, and Node.js 20+. Telegram setup requires network access and a Telegram account.
---

# Mode Creator

Create a useful note-taking system, not merely a valid JSON file. Interview the user, propose a small taxonomy, obtain approval, install it durably, configure optional alerts, restart the worker, and prove the active mode appears in startup context.

## Ground rules

- Use the available interactive question tool (`AskUserQuestion`, `request_user_input`, or equivalent) for the interview. Ask in small batches and wait for each response.
- Explain observation types as mutually exclusive kinds of notes and concepts as reusable tags. Avoid jargon unless the user uses it first.
- Inspect existing bundled and user modes before inventing a new one. Reuse or remix a close match when that serves the user better.
- Do not edit a plugin cache or bundled mode. Install custom files under the resolved claude-mem data directory's `modes/` folder.
- Do not expose a Telegram token in chat, command arguments, logs, or tool output. Treat it like a password.
- Preserve unrelated settings and existing Telegram triggers. The helpers make timestamped backups and merge requested triggers.
- Custom modes are supported by the local worker runtime. If `CLAUDE_MEM_RUNTIME` is `server`, explain that this workflow cannot safely install a per-user mode into the shared server and stop before mutation.
- Existing observations keep their original types. The new mode applies to future observation generation.

## 1. Open with the purpose

Begin with this message inside the first interactive question:

> Custom modes let you take notes for whatever you're working on. If you're a law student, you may want to write down every time a case establishes a rule, a professor flags an exam trap, or doctrines conflict. If you're an architect, you may want to capture every design decision, code constraint, client preference, or site discovery. What are you working on?

Do not start by asking for a mode name or JSON fields. Learn the work first.

If the answer is code-related, say:

> Code mode already works well for software work. A custom variant may work better if it also tracks [2–4 specific kinds of notes inferred from their work] and tags [2–4 useful cross-cutting themes]. Would you like to keep standard code mode or customize it?

Use concrete suggestions. For an ML platform engineer, for example, suggest experiment outcomes, data-contract changes, production incidents, model decisions, cost findings, and reproducibility risks—not generic “custom notes.” If the user chooses standard code mode, do not create a redundant file; continue to the optional notification and verification steps.

## 2. Discover what is worth remembering

Use follow-up questions to obtain:

1. Three examples of moments or findings they would want available next week.
2. Routine activity that should be skipped.
3. The nouns and decisions they search for later: people, cases, materials, clients, constraints, experiments, incidents, and so on.
4. Anything sensitive that should never be recorded or sent to Telegram.
5. Whether notes should be selective or detailed.

Infer answers already present in the conversation instead of asking twice. When the user gives a broad answer, propose examples and let them select or edit them.

## 3. Propose the mode

Read [references/mode-authoring.md](references/mode-authoring.md) before drafting.

Propose:

- A clear mode name and lowercase ID.
- Usually 4–8 observation types. Each observed item gets exactly one type.
- Usually 4–8 concept tags. An item may get several concepts.
- One-sentence recording and skipping policies.
- Two realistic notes the mode would record and two it would skip.

Present the proposal in plain language and use the interactive question tool for approval. Let the user rename, add, remove, or reword categories. Do not write or install until they approve the taxonomy and privacy boundary.

Prefer an inherited ID such as `code--architecture-practice` so the mode reuses claude-mem's stable output protocol while replacing the domain taxonomy and behavioral prompts. The `code` parent is an implementation base; the override must remove code-specific semantics from the prompts. Use a standalone mode only when inheritance is genuinely unsuitable.

## 4. Ask about Telegram alerts

After the taxonomy is approved, ask:

> Would you like Telegram notifications when claude-mem records any particular types or tags? Alerts include the observation type, title, subtitle, project, and observation ID, so avoid selecting categories that may expose sensitive material.

If yes:

- Let the user select exact observation types and/or concept tags from the approved mode.
- Explain that matching is OR: any selected type or any selected concept sends an alert.
- Ask whether they already have a Telegram bot connected to claude-mem.
- Read [references/telegram.md](references/telegram.md), then guide new users through BotFather and the secure setup helper.

If no, leave every Telegram setting unchanged.

## 5. Draft, validate, and install

Resolve the absolute directory containing this `SKILL.md`; all helper paths are relative to that directory.

Write the approved mode to a temporary JSON file. Use the exact inherited override shape in the authoring reference. Then validate without mutating anything:

```bash
node <skill-directory>/scripts/install-mode.mjs \
  --mode <temporary-mode.json> \
  --mode-id <parent--custom-id> \
  --dry-run
```

Fix every validation error before installation. Then install and activate it:

```bash
node <skill-directory>/scripts/install-mode.mjs \
  --mode <temporary-mode.json> \
  --mode-id <parent--custom-id> \
  --telegram-types <comma-separated-approved-types> \
  --telegram-concepts <comma-separated-approved-concepts>
```

Omit both Telegram flags when alerts were declined. The installer:

- Merges the override with its parent and validates the complete mode.
- Installs the source override under `<data-dir>/modes/`.
- Sets `CLAUDE_MEM_MODE` in `settings.json`.
- Merges approved alert triggers without deleting existing triggers.
- Writes atomically and reports any backup paths.

Review its JSON result. Do not claim success if `ok` is not `true`.

## 6. Connect Telegram when needed

If alerts were requested and both bot token and chat ID are already present, ask permission to reuse them and send a test. If credentials are missing, explain the BotFather steps from the Telegram reference.

Run the credential helper only after explicit consent:

```bash
node <skill-directory>/scripts/configure-telegram.mjs \
  --types <comma-separated-approved-types> \
  --concepts <comma-separated-approved-concepts>
```

The helper accepts the token through hidden terminal input, validates it with `getMe`, discovers or asks for the chat ID, sends a test message, and stores the settings with owner-only permissions. Never pass the token as an argument.

If the agent environment cannot give the user control of an interactive terminal, show the exact helper command and pause for the user to run it locally. This is the only acceptable manual boundary; do not ask them to paste the token into chat as a workaround. After they confirm, inspect only whether the credential fields are present—never print their values.

## 7. Restart and prove the result

Read the configured runtime before restarting. For a worker runtime, use the verified CLI restart path:

```bash
npx claude-mem restart
npx claude-mem status
```

If the CLI shim is unavailable, run the installed plugin's `scripts/worker-service.cjs restart` with Bun. Do not use a bare restart HTTP request when the verified CLI path is available.

Verify all of the following:

1. Restart reports a new healthy worker and exits successfully.
2. The installed file exists under the resolved data directory.
3. `settings.json` names the intended `CLAUDE_MEM_MODE` without displaying secrets.
4. Request full startup context with the `session_start_context` MCP tool when available. Otherwise call `/api/context/inject?project=mode-creator-verification&full=true` on the configured local worker.
5. Startup context contains `Mode: <mode name> (<mode id>)`.
6. If Telegram was configured, the test message arrived.

If the worker falls back to `code`, inspect the worker log for a mode validation or lookup error, repair the mode, and repeat the restart. Do not describe a fallback as successful activation.

## 8. Hand off clearly

Conclude with:

- Active mode name and ID.
- Installed path.
- Observation types and concepts.
- Telegram trigger types/concepts, or “unchanged.”
- Restart and startup-context verification result.
- Backup paths for rollback.
- One short example of what the new mode will now remember.

Never include the Telegram bot token in the handoff.
