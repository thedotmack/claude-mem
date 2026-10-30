# iMessage agent build test: one spec, built three ways

A coding agent (DeepSeek, through OpenRouter) builds the same app, the Photon iMessage agent in `spec.md`, three
times. Each build runs as six fresh sessions, and each build is scored against the spec's 26 checks.

- **The three builds:** plain Claude Code · regular claude-mem with no Wire Gateway · claude-mem with Endless Mode.
  Same model, same starting commit (`feat/wire-gateway` plus the spec), same prompts in the same order, same five
  claude-mem skills (make-plan, do, babysit, version-bump, childhood). Only the memory setup differs.
- **Six sessions, each fresh:** the prompt is the same one line every time ("continue building the spec in
  docs/specs/photon-imessage-agent.md"), so what a session knows about earlier ones has to come from memory or the
  repo. Session 1 also plants three decisions (the agent is called Juniper, a 4-second debounce, the receipt text
  "On it."), session 2 changes the debounce to 7 seconds, and session 3 is stopped on purpose after 40 tool calls.
  If the build hasn't marked itself complete after six, it gets up to two more "continue" sessions.
- **Scoring** (`score.py`) reads each build's repo and session logs, then drives the built agent on a fake iMessage
  line the spec's test appendix defines, with seeded work and rules. A judge model grades the answers against the
  seeded truth. Checks that need a real Mac, a phone or a GitHub release are marked "by hand" (see
  `scorecard-manual.md`).

## Run it (macOS)

From any claude-mem checkout:

```sh
git fetch origin test/imessage-agent-build-kit
git worktree add /tmp/cmem-imessage-kit origin/test/imessage-agent-build-kit
/tmp/cmem-imessage-kit/scripts/endless-mode-validation/imessage-build/run.sh
```

It builds all three side by side, scores them, and prints where the scorecard is (`~/cmem-imessage-build/<date-time>/
scorecard.md`). The OpenRouter key comes from `OPENROUTER_API_KEY`, or else from `CLAUDE_MEM_OPENROUTER_API_KEY` in
`~/.claude-mem/settings.json`; it is never printed or written to a file.

Options go after the output dir: `run.sh <out dir> --model <OpenRouter model> --arms plain,endless`. Score again
(for example with a different judge) with `score.py --out <out dir> --judge-model <model>`; `--quick` skips the
200-text conversation.

## Run it on Fly Sprites (instead of your Mac)

One Sprite per build, so the three builds never share a machine. From any claude-mem checkout on your Mac, with the
Sprites CLI installed (`curl https://sprites.dev/install.sh | bash`) and `sprite login` done:

```sh
git fetch origin test/imessage-agent-build-kit
git worktree add /tmp/cmem-imessage-kit origin/test/imessage-agent-build-kit
/tmp/cmem-imessage-kit/scripts/endless-mode-validation/imessage-build/sprites.sh start
```

Then `sprites.sh status` to check on them, `sprites.sh fetch` once all three say done (copies the results to
`~/cmem-imessage-build/sprites/` and writes the combined scorecard), and `sprites.sh destroy` when you're finished.

- **What's different on a Sprite:** it has no Claude login, so the note-taker (OpenRouter's newest-Haiku alias, never a
  dated model) goes through OpenRouter too, still through the recording proxy, so it's in the bill. The builder runs
  under bubblewrap instead of macOS's sandbox. Linux has no Messages, so no text can go out from a real Apple ID.
- **Cost of the Sprites themselves:** Fly lists $0.0385 per CPU-hour and $0.021875 per GB-hour of memory. A Sprite is
  8 CPUs and 4 GB, so one running flat out is at most about $0.40 an hour, $1.20 for all three. This is on top of the
  model bill and isn't in the scorecard.

## What stays safe

- **No texts from a real Apple ID:** on macOS, every builder session and every scoring step runs under `sandbox-exec`. It can't
  read the Messages database, run `osascript`, Shortcuts or `launchctl`, send AppleEvents, run tunnel tools, use the
  keychain, read your SSH, GitHub, npm, Claude or claude-mem credentials, or write anywhere in your home outside the
  run's own folder. Before anything runs, probes inside the sandbox check each of those, and the run stops if one
  gets through.
- **No pushes or releases of claude-mem:** each build's `origin` is a local copy. Git runs without your system and
  global config, so no keychain login reaches GitHub. Test packages go to a local npm registry (Verdaccio) per build.
- **GitHub, only if you opt in:** for the release steps on GitHub, create three throwaway private repos
  (`<prefix>-plain`, `<prefix>-claudemem`, `<prefix>-endless`) and a fine-grained token limited to them, then set
  `TEST_GH_REPO_PREFIX=<owner>/<prefix>` and `TEST_GH_TOKEN`.

## Cost

Every request goes through a recording proxy and is priced afterwards: the agent at OpenRouter's listed prices
(fetched at extract time, plus OpenRouter's own per-request charge where it sends one), and claude-mem's note-taker
(newest Haiku, through your Claude login) at Anthropic's list prices. The scorecard shows the full bill per build,
note-taker included, plus time and sessions used. Scoring's own model calls are not in the build bill.

## Files

- `spec.md`: the spec, as committed into each build, with a short test appendix (the fake line, unattended setup,
  test releases).
- `prompts.json`: the session prompts, planted decisions and the session-3 stop.
- `run.py`: builds (sandbox, repos, registries, stacks, sessions, cost extraction). Results in `results.sqlite`
  (`sessions`, `turns`, `requests`) and logs under `<out>/<build>/logs/sessions/`.
- `score.py`: scoring. Writes `<out>/<build>/score/result.json` and `<out>/scorecard.md`.
- `scorecard-manual.md`: the by-hand checks.
- `sprites.sh`, `sprite-setup.sh`, `sprite-job.sh`: the Fly Sprites runner (your Mac), each Sprite's setup, and its job.
