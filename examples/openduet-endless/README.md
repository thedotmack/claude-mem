# OpenDuet with Endless Mode

Runs [OpenDuet](https://github.com/CopilotKit/OpenDuet) (CopilotKit's open-source proactive agent) on your own
computer with every model call going to DeepSeek on OpenRouter through claude-mem's wire gateway. The gateway gives
OpenDuet two things:

- **Endless Mode**: finished tool work is folded into one-line memory rows, so a long conversation stops resending
  every old tool call and result.
- **Long-term memory**: what OpenDuet does is saved as claude-mem memories, and each new conversation starts with
  them.

claude-mem runs from this checkout (the wire gateway is not in a release yet) with its own data folder, so your main
claude-mem install and its database are not touched.

## What runs where

```
OpenDuet (localhost:3010)
  -> wire gateway  127.0.0.1:37878/r/openduet   Endless Mode, memory in, memory out
       -> https://openrouter.ai/api/v1          deepseek/deepseek-v4.1-flash-1017
  claude-mem worker 127.0.0.1:37877             turns captured calls into memories (same model, same key)
```

## Set up once

Needs Docker Desktop running, Bun 1.3+, Node, jq.

```sh
examples/openduet-endless/setup.sh
```

Then, yourself:

1. Put your OpenRouter key in `~/openduet-endless/OpenDuet/.env` as `OPENAI_API_KEY=sk-or-...`.
   A key made just for this shows its spend on its own on OpenRouter's Activity page.
2. Sign in to CopilotKit (free) once. OpenDuet keeps its chats there and will not start without it:

   ```sh
   cd ~/openduet-endless/OpenDuet
   npx --yes copilotkit@latest login
   npx --yes copilotkit@latest project select
   bun openbot/scripts/setup-learning.ts
   ```

## Use it

```sh
examples/openduet-endless/start.sh     # then open http://localhost:3010
examples/openduet-endless/status.sh    # what Endless Mode saved
examples/openduet-endless/gateway.sh routes list   # any other `claude-mem wire` command
python3 examples/openduet-endless/cost.py   # what OpenDuet's calls cost, at OpenRouter's prices right now
examples/openduet-endless/stop.sh
```

Memories are viewable at http://127.0.0.1:37877.

## What the patch changes in OpenDuet

`openduet-claude-mem.patch` adds two things to `openbot/server/src/copilot.ts`, both only active with this setup:

- With `OPENAI_BASE_URL` set, the whole conversation is sent on every request (`store: false`). OpenRouter does
  not keep conversations, so references to earlier replies would fail.
- With `CLAUDE_MEM_WORK_FOLDER` set, the prompt names that folder. The gateway files OpenDuet's memories under it,
  and only then brings them back into new conversations.

## Settings

Override any of these in the environment: `OPENDUET_ENDLESS_HOME` (default `~/openduet-endless`),
`OPENDUET_ENDLESS_MODEL`, `OPENDUET_ENDLESS_WORKER_PORT`, `OPENDUET_ENDLESS_GATEWAY_PORT`,
`OPENDUET_ENDLESS_MEMORY_FOLDER`, `OPENDUET_COMMIT`.

To run OpenDuet's chat on an Anthropic key instead, still through the gateway:

```sh
examples/openduet-endless/gateway.sh routes add openduet-anthropic --agent openduet --upstream https://api.anthropic.com --capture wire
examples/openduet-endless/gateway.sh routes endless openduet-anthropic on
```

and in OpenDuet's `.env`: `BOT_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`, `BOT_MODEL=<a Claude model>`,
`ANTHROPIC_BASE_URL=http://127.0.0.1:37878/r/openduet-anthropic`. The memory observer stays on OpenRouter.
