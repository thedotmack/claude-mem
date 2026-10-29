# OpenDuet with Endless Mode

Runs [OpenDuet](https://github.com/CopilotKit/OpenDuet) (CopilotKit's open-source proactive agent) on your own
computer with every model call going to DeepSeek on OpenRouter through claude-mem's wire gateway. The gateway gives
OpenDuet two things:

- **Endless Mode**: finished tool work is folded into one-line memory rows, so a long conversation stops resending
  every old tool call and result.
- **Long-term memory**: what OpenDuet does is saved as claude-mem memories, and each new conversation starts with
  them.

OpenDuet's chats stay on your computer too. OpenDuet normally keeps every conversation in CopilotKit's cloud
(CopilotKit Intelligence) and will not start without a CopilotKit sign-in. Here a small local chat store
(`local-chats/`) answers OpenDuet in its place and keeps the conversations in one SQLite file, so no sign-in is
needed.

claude-mem runs from this checkout (the wire gateway is not in a release yet) with its own data folder, so your main
claude-mem install and its database are not touched.

## What runs where

```
OpenDuet (localhost:3010)
  -> wire gateway  127.0.0.1:37878/r/openduet   Endless Mode, memory in, memory out
       -> https://openrouter.ai/api/v1          deepseek/deepseek-v4.1-flash-1017
  claude-mem worker 127.0.0.1:37877             turns captured calls into memories (same model, same key)
  local chat store 127.0.0.1:37879              OpenDuet's conversations, in ~/openduet-endless/chats/chats.db
```

## Set up once

Needs Docker Desktop running, Bun 1.3+, Node, jq.

```sh
examples/openduet-endless/setup.sh
```

Then, yourself: put your OpenRouter key in `~/openduet-endless/OpenDuet/.env` as `OPENAI_API_KEY=sk-or-...`.
A key made just for this shows its spend on its own on OpenRouter's Activity page.

## Use it

```sh
examples/openduet-endless/start.sh     # then open http://localhost:3010
examples/openduet-endless/status.sh    # what Endless Mode saved
examples/openduet-endless/gateway.sh routes list   # any other `claude-mem wire` command
python3 examples/openduet-endless/cost.py   # what OpenDuet's calls cost, at OpenRouter's prices right now
examples/openduet-endless/stop.sh
```

Memories are viewable at http://127.0.0.1:37877.

## Chats on your computer

The local chat store is in `local-chats/` (Bun and SQLite, nothing to install). OpenDuet itself is unchanged: setup
points its `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL` and `INTELLIGENCE_API_KEY` at the store. That key is
made by setup and used only between OpenDuet and the store on this computer.

- Kept: every conversation, its history when you come back to it, stopping a reply, scheduled and first-day turns.
- Back up or move your chats by copying `~/openduet-endless/chats/` while OpenDuet is stopped.
- The store claims no CopilotKit licence. OpenDuet handles that as it always has: conversations run, it keeps its
  memory in its own database, and the extras CopilotKit licenses are off (Automatic Learning, CopilotKit's memory
  service, CopilotKit's hosted thread list). OpenDuet's start check would stop on "licence is 'none'", so a small
  patch lets it through when `OPENDUET_LOCAL_CHATS=true` and the store answers.
- To keep chats in CopilotKit's cloud instead, run `OPENDUET_ENDLESS_CHATS=cloud examples/openduet-endless/setup.sh`
  and sign in to CopilotKit once from `~/openduet-endless/OpenDuet` (`npx --yes copilotkit@latest login`, then
  `npx --yes copilotkit@latest project select`, then `bun openbot/scripts/setup-learning.ts`). A CopilotKit key that
  was there before the switch to local is kept in `~/openduet-endless/copilotkit-cloud.env` and put back.

Tests: `bun test examples/openduet-endless/local-chats`.

## What the patches change in OpenDuet

`openduet-claude-mem.patch` adds two things to `openbot/server/src/copilot.ts`, both only active with this setup:

- With `OPENAI_BASE_URL` set, the whole conversation is sent on every request (`store: false`). OpenRouter does
  not keep conversations, so references to earlier replies would fail.
- With `CLAUDE_MEM_WORK_FOLDER` set, the prompt names that folder. The gateway files OpenDuet's memories under it,
  and only then brings them back into new conversations.

`openduet-local-chats.patch` changes the licence check in `openbot/scripts/start.sh`, as above.

## Settings

Override any of these in the environment: `OPENDUET_ENDLESS_HOME` (default `~/openduet-endless`),
`OPENDUET_ENDLESS_MODEL`, `OPENDUET_ENDLESS_WORKER_PORT`, `OPENDUET_ENDLESS_GATEWAY_PORT`,
`OPENDUET_ENDLESS_MEMORY_FOLDER`, `OPENDUET_ENDLESS_CHATS` (`local` or `cloud`), `OPENDUET_ENDLESS_CHATS_PORT`,
`OPENDUET_ENDLESS_CHATS_DB`, `OPENDUET_COMMIT`.

To run OpenDuet's chat on an Anthropic key instead, still through the gateway:

```sh
examples/openduet-endless/gateway.sh routes add openduet-anthropic --agent openduet --upstream https://api.anthropic.com --capture wire
examples/openduet-endless/gateway.sh routes endless openduet-anthropic on
```

and in OpenDuet's `.env`: `BOT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`, `BOT_MODEL=<a Claude model>`,
`ANTHROPIC_BASE_URL=http://127.0.0.1:37878/r/openduet-anthropic`. The memory observer stays on OpenRouter.
