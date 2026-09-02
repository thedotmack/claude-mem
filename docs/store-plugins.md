# claude-mem store plugins

Two listings, one repo. Cursor and Grok Bot plugin stores share the Cursor catalog (`SearchPlugins` / [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish)). **Do not treat the store listing as published until this PR lands and the repo is submitted there.**

Plugin ids (locked):

| Plugin | Install | Ingest | Observer |
|---|---|---|---|
| `claude-mem-cursor` | Grok Bot store or Cursor store | Cursor hooks | local host-login **or** remote cmem.ai |
| `claude-mem-grok-bot` | Grok Bot store or Cursor store | transcript watcher | local host-login **or** remote cmem.ai |

Neither listing requires the other IDE. Grok Bot is **not** Grok Build CLI (`xai-org/plugin-marketplace`).

Public user guide (Mintlify): [`docs/public/grok-bot/index.mdx`](../docs/public/grok-bot/index.mdx) → `/grok-bot` after this PR merges.

## Flags in this PR (not on main / npm 13.23.x)

Document these as **coming in #3842**, not as already shipping:

| Flag | Host | What it does |
|---|---|---|
| `npx claude-mem install --ide grok-bot` | Grok Bot | Transcript watcher + MCP + skills. **No hooks.** `platformSource=grok-bot`. |
| `npx claude-mem install --ide cursor` | Cursor | Hooks + MCP. `platformSource=cursor`. |
| both `--ide` flags together | optional | Independent installs; not required. |
| `--provider host` | both | Local OpenAI loopback. Logged-in host agent, **no API key**. Internally: `openrouter` + `CLAUDE_MEM_OPENROUTER_BASE_URL=http://127.0.0.1:<shim>/v1` + dummy non-empty key. **Not** `--provider grok`. |
| `--provider openrouter` | both | Remote (cmem.ai or any OpenAI-compat URL). Already on main. |
| `claude` \| `gemini` | both | Already on main. Keep. |
| `npx claude-mem mcp` | both | stdio MCP for `claude-mem-local`. |
| `npx claude-mem hook cursor <event>` | Cursor | `session-init` \| `context` \| `observation` \| `file-edit` \| `summarize`. |

Worker: local default, or existing `--runtime server --server-url`.

## Grok Bot install (user path)

Grok Bot has no session-start / file-read / tool-use hooks.

```bash
npx claude-mem install --ide grok-bot --provider host
```

That starts a local worker and a local host-login observer.

```bash
# optional: both hosts
npx claude-mem install --ide grok-bot --ide cursor --provider host

# remote worker
npx claude-mem install --ide grok-bot --runtime server --server-url https://YOUR_HOST

# remote observer
npx claude-mem install --ide grok-bot --provider openrouter
```

Do not require Claude CLI or an xAI API key. Do not document `--provider grok`.

`npm install -g claude-mem` is SDK-only and does not start the worker, watcher, or observer.

### After plugin install (MCP)

- Local: `npx -y claude-mem mcp`
- Remote: `https://cmem.ai/api/mcp` with `Authorization: Bearer ${CLAUDE_MEM_MCP_TOKEN}`

## Local vs remote

- **Local worker:** `npx claude-mem install --ide cursor|grok-bot` then MCP `claude-mem-local`
- **Remote worker:** plugin variable `CLAUDE_MEM_MCP_TOKEN` + MCP `claude-mem-remote` (`https://cmem.ai/api/mcp`)
- **Local observer:** `--provider host` (shim on a **free** port, never the worker port)
- **Remote observer:** existing openrouter / `https://cmem.ai/api/inference/v1`

**Port rule:** observer shim must not bind the worker port. Worker is often `37700 + (uid % 100)`. On macOS the worker is often **37777** → shim **37778** (or `CLAUDE_MEM_HOST_OBSERVER_PORT`). Never restart a healthy worker (RAM queue drops).

## XML contract (teach this)

Parser only accepts `skip_summary` | `observation` | `summary`. Prose like "still observing" is `outputClass=prose` and **drops the batch** ([issue #2485](https://github.com/thedotmack/claude-mem/issues/2485)).

Idle / init / no tool results:

```xml
<skip_summary reason="noise" />
```

Finished searchable unit: one `<observation>` covering the pile (real title, facts with paths, narrative). Never title with a tool name. Do not mix `skip_summary` and `<observation>`. Timeouts must return `skip_summary` XML, not HTTP 504.

## Publish (not done)

1. Land this PR (`#3842`): root `.cursor-plugin/marketplace.json` plus `claude-mem-cursor/` and `claude-mem-grok-bot/`.
2. Confirm `npx claude-mem mcp` and `npx claude-mem hook cursor …` exist on the branch.
3. **After merge**, submit the repo at https://cursor.com/marketplace/publish — that is the Grok Bot plugin store **and** the Cursor plugin store. Do not write this chapter as if the listing is already live.
4. Optional extra: Grok **Build** CLI marketplace is a different catalog (`xai-org/plugin-marketplace`).
5. Version bump after merge is parked as MINOR 13.23.1 → 13.24.0.
