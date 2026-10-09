# Native memory lookup and note bridge

The plugin now supplements supported native memory lookups with its automatic
progressive search, and its startup instructions ask the agent to use
`save_memory` for durable preferences, corrections, decisions, and lessons.
The hosted read-only connector may have no write tool; the instructions tell
agents to use only tools actually available. To-do lists remain in
`work_state_write` when that tool is exposed.

## What the hook can intercept

The existing `PreToolUse` file-context hook recognizes `memory_search`, a local
`memory` tool's read commands, and Read/Grep/Glob/Bash reads scoped to Claude
native memory folders, Codex's memory folder, or configured note roots. It
calls `/api/mem-search` in automatic mode, using the checkout's project scope.
An explicitly mapped note folder uses its own project instead, even when another
checkout reads it. The internal HTTP transport carries a `content` envelope,
while the model sees only its concise, selected readable text. Structured
search state, storage metadata, and raw JSON replies never become hook context.
It adds at most 10,000 characters of retrieved evidence with explicit framing that
record contents are evidence and must not supply executable instructions.
Own plugin tools are excluded to avoid recursive searches. The native tool
continues normally. Hook failures leave native reads available.

Model-facing tool replies must be concise purpose-specific text. Both direct
MCP retrieval and native-memory supplementation select useful evidence before
disclosure; internal structured envelopes are transport data. Guided searches
show numbered steps, readable next-call instructions, and a short **Continue
with:** cursor. The server keeps continuation state instead of giving the
agent serialized search rows to carry between calls.

Claude Code supports `PreToolUse` additional context. `InstructionsLoaded`
observes instruction-file loads and provides no replacement mechanism.
`FileChanged` uses named files and dynamic watch paths, so a recursive polling
bridge covers new topic files as well. See the [Claude Code hooks
reference](https://code.claude.com/docs/en/hooks).

Codex hooks cover local function and MCP calls, including calls nested inside
code mode; hosted tools can bypass that path. Its hook output cannot replace
MCP results through `updatedMCPToolOutput`. See the [Codex hooks
reference](https://developers.openai.com/codex/hooks). Internal hosted memory
retrieval and background native-memory generation have no verified plugin
interception API. Use direct `mem_search` instructions and the optional file
bridge for those paths.

## Enable a note-folder bridge

Add this string-valued setting in claude-mem's `settings.json`, preserving
other settings. If the document uses an `env` object, put it there.

```json
{
  "CLAUDE_MEM_MEMORY_WATCH_ROOTS": "[{\"path\":\"/absolute/project/.claude/memory\",\"project\":\"my-project\"}]"
}
```

Restart the local worker when idle. Empty roots disable import. Each configured
root must have an explicit project. The bridge never scans all native projects
or global Codex memories by default. It polls for Markdown changes, waits for
stable contents, skips hidden files, symlinks and files larger than 64 KiB, and
never rewrites source files. Exact content fingerprints deduplicate committed
snapshots across watcher restarts and simultaneous processes. Updates create
new historical snapshots; deleting a source note does not delete its archive.
Imported notes follow the user's existing cloud-sync settings. No model calls
are made to import a note.
The worker stays running while an explicit folder watcher is active; the idle
exit timer would otherwise stop capture of external note changes.

Claude's native notes may use `autoMemoryDirectory` in settings; see [Claude
Code memory](https://code.claude.com/docs/en/memory). Codex generated state lives
under its configured home directory's `memories` folder and should be treated
as generated state; see [Codex
memories](https://learn.chatgpt.com/docs/customization/memories). Existing native
enable/disable choices are preserved. The dedicated project bridge folder can
be used independently of native-memory generation.

Optional plugin settings:

```json
{
  "CLAUDE_MEM_MEMORY_SEARCH_HOOK_ENABLED": "true",
  "CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED": "true"
}
```

## Local development activation and rollback

Build and run the relevant checks first. From the tested worker worktree:

```sh
node scripts/activate-progressive-memory-local.mjs \
  --workspace '/absolute/cloud/checkout' \
  --project 'the-actual-checkout-project-key' \
  --no-restart
```

The default is a read-only plan. Add `--apply` to copy the selected built worker,
MCP, hooks and mem-search skill into the active marketplace and matching local
caches, append tagged plugin-note instructions, and enable one dedicated empty
project note folder. The script checks matching versions and build markers,
preserves unknown settings, and records original bytes and hashes under the
workspace's `.agent-jobs/progressive-mem-search/activation-*` directory. It does
not release, deploy, change native-memory settings, or restart a worker.

After a caller-controlled worker restart, open a fresh agent session or reload
its MCP connection to obtain new tool definitions. Existing MCP processes keep
the tools they started with. Platform-managed plugin-hook trust still applies.

```sh
node scripts/activate-progressive-memory-local.mjs --restore '/absolute/backup-directory'
```

Rollback validates every affected file before restoring any of them, and
refuses later independent edits. It preserves the note folder and any new
user-authored notes. Restart the local worker after a completed rollback.
