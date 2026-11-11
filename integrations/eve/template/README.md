# eve agent with claude-mem

A personal [eve](https://eve.dev) agent that already knows your work. It recalls your [claude-mem](https://github.com/thedotmack/claude-mem) memory before every reply: what you built, decided, and fixed in Claude Code, Codex, and your other agents. You can chat with it in the browser and add iMessage with one command.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fthedotmack%2Fclaude-mem%2Ftree%2Fmain%2Fintegrations%2Feve%2Ftemplate&env=EVE_CHAT_PASSWORD%2CCLAUDE_MEM_API_KEY&envDescription=EVE_CHAT_PASSWORD%3A%20a%20strong%20password%20%2816%2B%20characters%29%20that%20protects%20your%20agent.%20CLAUDE_MEM_API_KEY%3A%20your%20key%20from%20https%3A%2F%2Fcmem.ai%2Fpro%2Fkey.&envLink=https%3A%2F%2Fgithub.com%2Fthedotmack%2Fclaude-mem%2Fblob%2Fmain%2Fintegrations%2Feve%2Ftemplate%2Fdocs%2Fsetup-and-deploy.md&project-name=claude-mem-agent&repository-name=claude-mem-agent&demo-title=eve%20agent%20with%20claude-mem&demo-description=A%20personal%20eve%20agent%20that%20remembers%20what%20you%20did%20in%20Claude%20Code%2C%20Codex%2C%20and%20your%20other%20agents.)

## Quick Start

1. Click **Deploy with Vercel**.
2. Enter a strong `EVE_CHAT_PASSWORD` (16+ characters).
3. Enter `CLAUDE_MEM_API_KEY`, copied from [cmem.ai/pro/key](https://cmem.ai/pro/key).
4. Open the deployed app, enter the password, and ask "what was I working on yesterday?"

No database or Marketplace product is needed. Chats are stored in your browser. Memory lives in claude-mem.

The agent uses eve's default model, `anthropic/claude-sonnet-5`, through Vercel AI Gateway. The AI Gateway free tier does not include Claude models. Add [AI Gateway credits](https://vercel.com/docs/ai-gateway/pricing), or change `model` in `agent/agent.ts`.

## What the agent does with your memory

- **Recall:** before every turn, it searches your claude-mem memory for your message. Matches reach the model as data, not instructions.
- **Search:** the `claude-mem__search` tool lets the model look further back.
- **Remember:** the `claude-mem__remember` tool saves a note to the `eve-agent` project in claude-mem. It runs only when the model decides to save, and the model tells you when it does. Turns are never saved automatically.
- **Owner only:** recall reads your whole memory, so `agent/memory/claude-mem.ts` turns memory on only for you. Anyone else who reaches the agent gets no memory and no memory tools.

Saving needs a key with write access, which is a Pro key from [cmem.ai/pro/key](https://cmem.ai/pro/key). A read-only key still recalls and searches, and `remember` then reports that saving is not allowed.

## Text it over iMessage

iMessage is an eve add-on. Run one of these from the project, then redeploy:

```bash
npx eve add channel/linq     # guided: creates a Linq line through Vercel Connect
npx eve add channel/photon   # or Photon
```

Set `CLAUDE_MEM_OWNER_PHONE` to your own number (or Apple ID) in the Vercel project. Texts from that handle get your memory. Texts from anyone else get none.

To stop strangers who text the line from spending your model budget, ignore their messages in the channel file that `eve add` writes:

```ts title="agent/channels/linq.ts"
import { connectLinqCredentials } from "@vercel/connect/eve";
import { defaultLinqAuth, linqChannel } from "eve/channels/linq";

const owner = process.env.CLAUDE_MEM_OWNER_PHONE?.replace(/[\s().-]/g, "");

export default linqChannel({
  credentials: connectLinqCredentials("linq/claude-mem-agent"),
  onMessage(_ctx, message) {
    if (message.author.userId.replace(/[\s().-]/g, "") !== owner) return null;
    return { auth: defaultLinqAuth(message) };
  },
});
```

Slack, Telegram, WhatsApp, Discord, and the rest of [eve's channels](https://eve.dev/integrations) work the same way with `npx eve add channel/<name>`.

## Deployment Modes

| Mode              | Selected when                                                       | Authentication                            | Chat persistence     | Long-term memory                        |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------- | -------------------- | --------------------------------------- |
| Starter           | `EVE_CHAT_PASSWORD` is configured                                   | Shared password and secure session cookie | Browser localStorage | claude-mem, for the password holder     |
| Production        | Neon, Upstash, and all Sign in with Vercel variables are configured | Sign in with Vercel                       | Neon                 | claude-mem, for `CLAUDE_MEM_OWNER_EMAIL` |
| Local development | Neither mode is configured and `next dev` is running locally        | Local development identity                | Browser localStorage | claude-mem                              |

Production mode takes precedence when its complete environment is present. The app fails closed in a production deployment when neither mode is configured. See [Setup and Deployment](docs/setup-and-deploy.md) for the upgrade path.

## Getting Started

For the starter and production setup flows, see [Setup and Deployment](docs/setup-and-deploy.md). For the runtime architecture, streaming model, persistence flow, and extension points, see [How the Chatbot Works](docs/how-the-chatbot-works.md).

Install dependencies with pnpm:

```bash
pnpm install
```

Run the web app locally without additional services:

```bash
pnpm dev
```

To run the web app and eve as the Vercel service graph without linking a Vercel project, use:

```bash
pnpm dev:all
```

To require the same password locally, put this in `.env.local`:

```bash
EVE_CHAT_PASSWORD=<at-least-16-characters>
```

To upgrade the linked project to production mode, run the setup script. It provisions Neon and Upstash, registers Sign in with Vercel, pulls environment variables, and runs migrations:

```bash
./scripts/setup.sh
# Or: ./scripts/setup.sh --scope <team-slug>
```

Production mode requires:

```bash
DATABASE_URL=
BETTER_AUTH_SECRET=
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=
VERCEL_APP_CLIENT_SECRET=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

Other optional environment variables:

```bash
# Override the app origin for custom production domains.
BETTER_AUTH_URL=

# Enable hosted Vercel Connect integrations.
SLACK_CONNECTOR=
LINEAR_CONNECTOR=
NOTION_CONNECTOR=
SENTRY_CONNECTOR=
```

Create optional Vercel Connect integrations:

```bash
# Slack channel
vercel connect create slack --name eve-chat-template --triggers
vercel connect attach <slack-connector-uid> --triggers --trigger-path /eve/v1/slack --yes

# MCP connections
vercel connect create mcp.notion.com --name notion
vercel connect create https://mcp.linear.app/mcp --name linear
vercel connect create https://mcp.sentry.dev/mcp --name sentry
```

The deploy button does not require these integrations. For manual setup, put the returned connector UIDs in `SLACK_CONNECTOR`, `NOTION_CONNECTOR`, `LINEAR_CONNECTOR`, and `SENTRY_CONNECTOR`. Local development falls back to `slack/eve-chat-template`, `notion`, `linear`, and `sentry`, so connectors created with the names above work without editing `agent/`.

The composer only shows its connections menu when at least one MCP connector is configured. Password-only starter deployments therefore omit the menu and do not prompt eve to use unavailable connections.

If the connector is not attached to the linked project, run:

```bash
vercel connect attach <connector-uid> --yes
vercel env pull .env.local
```

Production mode only: create the database tables:

```bash
pnpm db:migrate
```

For production, run migrations with Vercel production env vars:

```bash
vercel env run -e production -- pnpm db:migrate
```

Start the web app development server:

```bash
pnpm dev
```

Use `pnpm dev:all` to run the full Vercel service graph locally without linking a Vercel project.

## What Is Included

- Text chat with an eve agent through same-origin `/eve/v1/*` routes
- Password access with browser-backed chat history by default
- Optional Better Auth sign-in with Vercel
- Optional Neon-backed cross-device chat history
- Optional Upstash Redis rate limiting in production mode
- claude-mem long-term memory (recall, search, and deliberate saves), limited to the owner
- Drizzle schema and migrations for production mode under `apps/web/lib/db`
- Saved eve session cursors and event snapshots in either storage mode
- Sidebar history with delete and new-chat actions
- Vercel Connect-backed Notion, Linear, and Sentry MCP connections
- Vercel Connect-backed Slack channel route at `/eve/v1/slack`
- Composer-level connections menu
- First-message chat titles derived locally from the user's prompt
- Streamdown markdown rendering for assistant text and reasoning
- shadcn/Tailwind components for messages, tools, HITL prompts, and composer

This template intentionally does not include file uploads, guest mode, NextAuth/Auth.js, or AI Elements.

## Agent Code

Edit the agent in `agent/agent.ts`. Its behavior is defined in `agent/instructions.md`, tools live in `agent/tools/`, and `agent/memory/claude-mem.ts` connects your claude-mem memory.

The browser talks to eve with `useEveAgent()` from `eve/react`; the app stores eve stream events and session state so `/chat/[id]` can resume the same durable conversation after refresh.

## Credits

Built on the [eve Chat Template](https://github.com/vercel/eve/tree/main/apps/templates/eve-chat-template) from [vercel/eve](https://github.com/vercel/eve) (Apache-2.0). Changes: claude-mem memory replaces Blob file memory, the owner-only memory scope, and iMessage setup docs.
