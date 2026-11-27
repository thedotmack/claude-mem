# Try the dated chat importer

We'd like people who have real conversations in several projects to try this PR. Check whether the preview is easy to understand and whether an observation lands where you remember the work happening.

## Paste this into your local agent

> Use my current working directory as the workspace. Find the built Claude-Mem PR checkout and run its `dist/npx-cli/index.js import chats --workspace` with Node from this directory. Use a fresh, private `CLAUDE_MEM_DATA_DIR`. Tell me how many chats, projects and dated turns the preview finds. If I ask you to apply it, use an installed local Ollama chat model with `--apply --limit 4 --proof` and save the detailed output privately on this machine. Verify a real session with the checkout’s `scripts/verify-chat-import.ts`. Give me the UTC dates and counts of timeline matches, repeat model calls and duplicate observations. Keep the transcripts and observation titles on this device.

## Start with a preview

Check out the PR, install its dependencies, and build it. Use the checkout's CLI so you test the proposed change. The commands below use a POSIX shell and an isolated local data directory.

```sh
npm install
npm run build
export CLAUDE_MEM_DATA_DIR="$(mktemp -d)"
```

For local Claude Code or Codex history, run the CLI from the project you want to import. Use the absolute path to the built PR checkout.

```sh
node /path/to/pr-checkout/dist/npx-cli/index.js import chats --workspace
```

To preview an export instead, run this in the PR checkout.

```sh
node dist/npx-cli/index.js import chats "/path/to/your/export"
```

Select a ChatGPT or Claude export, or a local Claude Code or Codex JSONL session. The preview reports how many chats, projects and dated messages it recognizes in the last 30 days. If your export omits a project association, you can supply a fallback with `--project "Project name"`.

With `--apply`, the local model selects short passages after Claude-Mem applies your configured privacy filters. Each saved fact quotes the original speaker, carries the source message’s date, and follows your existing Cloud Sync settings. Use the isolated data directory above for a private test.

## Compare the original date with the timeline

For a quick test, start Ollama with a locally installed chat model. Substitute its name from `ollama list` for `MODEL_NAME`. This verifier runs the first four eligible messages from each selected file through the observer, closes and reopens a disposable database, and checks the date, quoted passage and speaker of each saved observation against its source message and project timeline. Passing an original Claude Code JSONL file also checks the passage and timestamp directly against the unmodified file. It then repeats those same messages and checks for duplicate observations and inference calls. Its report contains counts and UTC dates. A partial report lists unverified turns and checks repeat behavior only for completed turns. An unverified turn remains eligible for another local model.

```sh
bun scripts/verify-chat-import.ts "/path/to/your/export" --model MODEL_NAME
```

Pass a second path to compare two real projects. `--per-file 8` checks a longer prefix of each input. For a historical archive, `--as-of YYYY-MM-DDT23:59:59Z` sets the end of the verification window. The source timestamps are preserved. To keep completed results while trying another model, create a private directory with `mktemp -d` and pass the same path with `--checkpoint-dir` on each verifier run. That directory contains the local test database and selected passages.

To try the normal CLI, use the isolated data directory above. `--limit` caps new model calls per run. Running it again continues from the next eligible message. `--proof` displays observation IDs, projects, source message IDs and original dates locally. Open an observation in your local timeline to read its selected excerpt.

```sh
node dist/npx-cli/index.js import chats "/path/to/your/export" --apply --limit 4 --model MODEL_NAME --proof
```

## Tell us how it went

Privately compare a few titles and facts with the original messages. Check whether the excerpt is useful on its own, retains the speaker’s qualifiers, and lands in the correct project. Comment on the PR with the source app and export format, the local model, the counts you expected and saw, whether dates and projects matched, and any setup step that was unclear. If you saw a duplicate or an unexpected skip, include the counts before and after a rerun. Keep your chat text, private project names, exports and the detailed local proof in your own workspace.
