# How the Chatbot Works

This document explains the eve chat template end to end. It is written for
future maintainers who need to understand why the app is shaped this way, where
state lives, how messages stream, and how to safely change the chat experience.

The short version: this is not a generic stateless chat UI. The browser talks to
an eve agent through same-origin `/eve/v1/*` routes, persists eve stream events
and the eve session cursor in either browser storage or Postgres, and uses a
static Next.js shell so the sidebar and composer do not thrash during route
navigation.

## Main Pieces

The template has four major layers:

1. The eve agent layer in `agent/`
2. The Next.js shell and page layer in `apps/web/app/`
3. The chat UI components in `apps/web/components/chat/`
4. The persistence, auth, setup, and rate-limit layer in `apps/web/lib/`

Important files:

| File                                             | Purpose                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `agent/agent.ts`                                 | Defines the eve agent and model.                                                                    |
| `agent/channels/eve.ts`                          | Configures the eve web channel and auth adapters.                                                   |
| `agent/channels/slack.ts`                        | Configures the Slack channel route and Vercel Connect credentials.                                  |
| `agent/connections/notion.ts`                    | Defines the Notion MCP connection through Vercel Connect.                                           |
| `agent/connections/linear.ts`                    | Defines the Linear MCP connection through Vercel Connect.                                           |
| `agent/connections/sentry.ts`                    | Defines the Sentry MCP connection through Vercel Connect.                                           |
| `agent/instructions.md`                          | Defines the agent's behavior and long-term-memory rules.                                            |
| `agent/memory/claude-mem.ts`                     | Connects the owner's claude-mem memory and limits it to the owner.                                  |
| `vercel.ts`                                      | Composes the peer Next.js and eve services for Vercel.                                              |
| `apps/web/app/(chat)/layout.tsx`                 | Renders the static chat shell immediately, then streams viewer/setup/sidebar data through Suspense. |
| `apps/web/app/(chat)/page.tsx`                   | Root chat screen. Creates a new chat row and navigates into `/chat/[id]`.                           |
| `apps/web/app/(chat)/chat/[id]/page.tsx`         | Session route. Streams the active chat data into the client shell.                                  |
| `apps/web/app/_components/agent-chat-shell.tsx`  | Client shell for sidebar state, history pagination, auth modal, and shared chat context.            |
| `apps/web/app/_components/home-chat-page.tsx`    | Root-page composer and logo experience.                                                             |
| `apps/web/app/_components/session-chat-page.tsx` | Session-page composer, active chat sync, and controller wiring.                                     |
| `apps/web/app/_components/agent-chat.tsx`        | The eve client bridge: sending, streaming, persistence, resume, pending auth, and display state.    |
| `apps/web/components/chat/composer.tsx`          | The controlled chat input.                                                                          |
| `apps/web/components/chat/message.tsx`           | Renders eve messages, markdown, reasoning, tools, and input requests.                               |
| `apps/web/components/chat/sidebar.tsx`           | Paginated chat history sidebar.                                                                     |
| `apps/web/components/chat/integrations-menu.tsx` | Per-turn connection toggle UI.                                                                      |
| `apps/web/app/actions/chat.ts`                   | Server actions for chat creation, persistence, pending state, and rate checks.                      |
| `apps/web/app/api/chats/route.ts`                | Paginated chat history endpoint.                                                                    |
| `apps/web/lib/chat/local-store.ts`               | Versioned browser storage for starter-mode chats and eve session cursors.                           |
| `apps/web/lib/chat/persistence-client.ts`        | Routes client persistence calls to browser or database storage.                                     |
| `apps/web/lib/db/schema.ts`                      | Drizzle tables for Better Auth, chats, and chat events.                                             |
| `apps/web/lib/db/queries.ts`                     | Chat list, chat load, event save, snapshot save, and delete queries.                                |
| `apps/web/lib/setup.ts`                          | Selects starter, local development, or production mode and validates readiness.                     |
| `apps/web/lib/auth.ts`                           | Better Auth configuration with Sign in with Vercel.                                                 |
| `apps/web/lib/password-auth.ts`                  | Shared-password verification and stateless signed session cookies.                                  |
| `apps/web/lib/eve-auth.ts`                       | Converts password or Better Auth sessions into eve channel principals.                              |
| `apps/web/lib/rate-limit.ts`                     | Upstash Redis based fixed-window rate limiting.                                                     |

## Runtime Model

There are two related but separate concepts:

1. A **local app chat**, represented by a browser-storage record or a row in the `chat` table.
2. An **eve session**, represented by eve's `ClientSessionState` and remote session
   stream.

The app chat gives the user a stable URL such as `/chat/abc`, a sidebar title,
and persisted event history. The eve session is the durable conversation state
that eve uses to continue, wait for authorization, resume streams, and accept
follow-up input.

Production mode stores eve session state on the chat row:

```ts
chat.eveSession: ClientSessionState | null
```

Production mode stores eve stream events in ordered rows:

```ts
chat_event.eventIndex: number
chat_event.event: SessionStreamEvent
```

Starter mode keeps the same two values in a versioned localStorage record.
Those two pieces are intentionally separate. The `eveSession.streamIndex` tells
eve where to resume from in the remote session stream. The local
`chat_event.eventIndex` tells Postgres how to order the event log for rendering.
Do not treat those indices as interchangeable.

Long-term memory is separate from both app-chat persistence and eve session
history. `agent/memory/claude-mem.ts` recalls from the owner's claude-mem
memory on cmem.ai before each turn and gives the model `search` and `remember`
tools. Its scope admits only the owner, so other callers get no memory.

## Rendering Strategy

The app uses Next.js App Router with Cache Components enabled. The chat shell is
designed to render immediately, while dynamic data streams in behind hidden
Suspense boundaries.

### Shell First

`apps/web/app/(chat)/layout.tsx` renders this immediately:

```tsx
<AgentChatShell
  initialChats={[]}
  initialNextCursor={null}
  setupStatus={getInitialSetupStatus()}
  viewer={null}
>
  {children}
  <Suspense fallback={null}>
    <ResolvedChatBootstrap />
  </Suspense>
</AgentChatShell>
```

The shell can paint the sidebar frame, top-right auth buttons, and route body
without waiting for the database or auth session. Then `ResolvedChatBootstrap`
fetches:

- setup readiness from `getSetupStatus()`
- the password, local-development, or Better Auth viewer from `getServerViewer(setupStatus)`
- the first page of database chat history in production mode

In starter mode, the client reads sidebar history from browser storage after
the viewer resolves.

It passes that data through `AgentChatBootstrapSync`, which dispatches a browser
event. `AgentChatShell` listens for that event and merges the real viewer,
setup status, and sidebar history into client state.

This pattern avoids a blocking route, which would delay the entire page.

### Session Route Data

`apps/web/app/(chat)/chat/[id]/page.tsx` uses the same idea. It renders the session page
shell first:

```tsx
<SessionChatPage chatId={chatId}>
  <Suspense fallback={null}>
    <ExistingChat chatId={chatId} />
  </Suspense>
</SessionChatPage>
```

`ExistingChat` loads the active chat from Postgres in production mode and emits it through
`AgentChatRouteSync`. `SessionChatPage` listens for that sync event and then
passes the loaded `ActiveChat` into `AgentChatSession`.

This is why the top bar, sidebar, and composer can stay stable while the chat
body itself waits for data.

## Sidebar State And Pagination

The sidebar is owned by `AgentChatShell`.

State it owns:

- desktop sidebar open or closed
- mobile sidebar drawer open or closed
- current history page
- next cursor
- active chat id
- viewer
- setup status
- auth modal state
- enabled connection toggles

The desktop open/closed state is persisted in a cookie:

```ts
SIDEBAR_COOKIE_NAME = "eve-chat-sidebar";
```

`SidebarCookieScript` writes an early document hint before React hydrates. That
prevents the sidebar from opening for a frame and then collapsing.

Chat history is paginated. The first page is loaded by `ResolvedChatBootstrap`.
More pages are loaded from:

```txt
GET /api/chats?cursor=<cursor>
```

`listChatsPageByUser` orders by `updatedAt desc, id desc` and fetches
`CHAT_HISTORY_PAGE_SIZE + 1`, where the page size is currently 20. The extra
row determines whether there is a next cursor.

The cursor is encoded as:

```txt
<updatedAt ISO string>::<chat id>
```

The sidebar uses an intersection observer sentinel at the bottom of the list.
When it becomes visible, `AgentChatShell.loadMoreChats()` fetches the next page
and appends only chats that are not already present.

Creating, sending to, or deleting a chat updates the sidebar optimistically
through:

- `touchChat(chat)`
- `removeChat(chatId)`
- `updateChatTitle(chatId, title)`

## Root Page Flow

The root route is `apps/web/app/(chat)/page.tsx`, rendered by `HomeChatPage`.

The root page is the "start a new chat" experience. It has:

- the eve logo
- a centered composer
- footer links
- the shared sidebar and top auth controls from `AgentChatShell`

When the user submits the first message:

1. The input is trimmed.
2. If setup is incomplete, an error toast explains what is missing.
3. If the user is not signed in, `requestSignIn(message)` opens the auth modal
   and saves the draft in `sessionStorage`.
4. If the user is signed in, `createChatAction({ pendingUserMessage: message })`
   creates a chat row.
5. The chat title is derived from the first user message with
   `createFallbackTitle`.
6. The new chat is inserted into the sidebar with `touchChat(created)`.
7. The app navigates to `/chat/<id>`.

The root page does not call eve directly. It creates the app chat first and
lets the session route consume the pending message once the eve client is ready.

That matters because a chat URL should exist before the first response starts
streaming.

## Session Page Flow

The session route is rendered by `SessionChatPage`.

`SessionChatPage` owns:

- the loaded `ActiveChat`
- the controlled composer draft
- a ref to the `AgentChatController`
- loading/error UI for the route
- the pending user message loaded from the database

The `AgentChatController` is provided by `AgentChatSession`:

```ts
type AgentChatController = {
  reset: () => void;
  sendMessage: (text: string, draftHandlers: DraftHandlers) => Promise<void>;
  stop: () => void;
};
```

The session composer calls `controller.sendMessage(text, handlers)`.

If the route loaded a `pendingUserMessage`, `SessionChatPage` auto-consumes it
once:

- the chat has loaded
- the controller exists
- the controller is not busy
- the controller is not disabled by setup or pending authorization

This is how the first message from the root page actually gets sent to eve after
navigation.

## eve Client Bridge

Most of the chat logic lives in `apps/web/app/_components/agent-chat.tsx`.

The core hook is:

```tsx
const agent = useEveAgent({
  initialEvents: activeChat?.events ?? [],
  initialSession: activeChat?.session,
  onSessionChange: (session) => {
    if (session) void persistSessionState(session);
  },
  onEvent: persistStreamEvent,
});
```

`useEveAgent` handles reducing eve stream events into renderable chat messages.
The template wraps it with persistence and resume logic.

### Persisted session and streaming

`useEveAgent` owns the eve session and stream. The template passes the saved
`initialSession` cursor and `initialEvents` when the chat mounts, then renders
`agent.messages` directly. It does not maintain a second projection or
merge local events into the server log.

`onSessionChange` saves the session ID and cursor. `onEvent` persists each newly
accepted event; overlapping replay events are deduplicated by eve using their
stream positions before that callback runs. A React effect saves the hook's full
snapshot when committed state is idle, failed, or waiting for a person. It also
saves a settled or paused tail after `resume()` catches up.

The hook keeps following the stream across turn boundaries, sign-in callbacks,
and transport reconnects. The template does not implement a separate stream
reader. The app talks to eve's same-origin session API, routed to the eve service
by `vercel.ts`, rather than to a model endpoint.

## Sending A Message

Follow-up messages are sent by `AgentChatSession.sendMessage`.

The intended order is:

1. Ignore empty input.
2. Ignore if the session is already busy.
3. If eve is waiting on connection authorization, do not send regular user
   text. Show a helpful error instead.
4. Render an optimistic user bubble immediately when possible.
5. Run `prepareSend(message)`.
6. Mark the chat row with `pendingUserMessage`.
7. Call `agent.send(message, { clientContext })`, using `turnPolicy: "steer"`
   if a turn is still streaming while waiting for a response.
8. Observe execution through the hook's shared state. `send()` resolves with a
   delivery receipt at acceptance; it does not wait for execution or persistence.

`prepareSend` does the things that must happen before talking to eve:

- verify setup is ready
- request sign-in if there is no viewer
- check Redis rate limits
- create a chat row if one does not exist yet
- navigate to the new chat URL when necessary

The optimistic user bubble is separate from persisted eve events. It is created
with `createPendingUserMessage` while the app prepares the send. Once the
hook projects that message, `hasLatestUserMessage` clears the local pending
bubble; the hook reconciles its own optimistic message with the server.

This keeps the UI feeling immediate while still letting eve produce the
canonical event log.

## Persistence Model

The app persists at two moments:

1. As each stream event arrives
2. When the final snapshot is available

### Event-By-Event Persistence

`persistStreamEvent(event)` writes each event through:

```ts
appendChatEventAction({
  chatId,
  event,
  eventIndex,
});
```

`eventIndex` is a local monotonic counter for the current chat. The database has
a unique index on `(chatId, eventIndex)`, and writes use conflict updates so
retrying a write can replace the same slot.

This event-by-event persistence is what makes refresh/resume possible even if
the browser closes mid-turn.

### Snapshot Persistence

The template saves a snapshot when the hook's committed state is idle, failed, or
waiting for a person. It reads `activity(agent.view)` and the hook's status in an
effect, rather than treating command acceptance as a response boundary.
`onFinish` now means a live turn settled; it does not fire for a pause or replayed
history, so this template does not use it as its persistence trigger.

The snapshot includes:

- the authoritative, deduplicated event list known by eve React
- the current eve `ClientSessionState`

The template calls `saveChatSnapshotAction({ chatId, events, session })`.

`saveChatSnapshot` upserts each event by index, saves the eve session state,
clears `pendingUserMessage`, and updates the chat timestamp. It does not delete
events beyond the snapshot's length, because a newer stream append may already
have reached storage.

Within a mounted chat, persistence writes run in order: events, session cursors,
snapshots, and pending-message updates share one queue. Snapshot writes retain
event rows appended after the captured snapshot. The composer does not use a
separate "Finishing response" lock.

## Pending Message Recovery

`pendingUserMessage` exists for interrupted first sends and interrupted
follow-up sends.

The flow:

1. Before sending to eve, the app calls `markChatPendingMessageAction`.
2. The chat row stores:
   - `pendingUserMessage`
   - `pendingUserMessageCreatedAt`
3. If the page refreshes before the turn completes, `getChatForUser` returns the
   pending message.
4. `SessionChatPage` consumes it once the controller is ready.
5. After a settled event is persisted, `getChatForUser` hides stale pending
   messages.
6. `saveChatSnapshot` clears pending state, including after a cancellation.

This gives the app a way to recover from "message was accepted by the UI but the
browser left before eve completed."

## Refresh And Resume

When a saved chat has an eve session, `AgentChatSession` calls `agent.resume()`
once the viewer is available and the hook is ready. Waiting for the viewer
avoids opening an unauthenticated stream during shell bootstrap.

The hook catches up from the saved session, deduplicates overlapping events,
and follows any in-flight work. A settled chat returns to `ready` after catch-up;
a running or paused turn continues streaming. `resume()` resolves at catch-up,
not at the running turn's end. The same event and cursor callbacks, plus the
shared-state snapshot effect, persist both resumed and newly sent work.

Do not pass `events.length` as a stream cursor: a single stream line can contain
several facts. The hook owns that mapping. While its status is `resuming`, the
composer and interaction responses are disabled.

## Authorization Flow For Connections

Connections are not string-parsed from assistant text. eve opens a structured
sign-in interaction.

When a connection requires auth, eve emits:

```txt
interaction.opened   (request.kind: "sign-in")
```

The UI reads `agent.view.interactions` through the `interaction` selector from
`eve/events` and selects open interactions whose request has `kind: "sign-in"`. It does not scan or interpret the event log.

For each pending authorization, the UI renders `ConnectionAuthorizationPrompt`.

The prompt can show:

- the connection display name
- the authorization description
- a Connect link if eve provided one
- a Skip button

While an authorization is pending, regular chat input is disabled for that
session. This is intentional because eve is waiting for a structured outcome,
not a normal user message.

### Connect

Clicking Connect opens the authorization URL provided by eve. After the user
authorizes the connection, eve should receive the callback and continue the
turn. The browser stream then receives the next events for that same eve
session.

### Skip

Skip cancels the current turn without connecting the service.

`handleSkipAuthorization` calls `agent.cancel()` to request cancellation of the
server-side turn. The stream stays attached and receives the authoritative
interaction and turn settlements. Normal persistence callbacks save those facts
and clear pending state.

Skip ends the current turn, not the session. The next normal message continues
the same eve session with its existing context. The template never invents
settlement events or abandons the session locally.

## Connections Menu

The composer footer contains `ComposerFooterControls`, which renders
`IntegrationsMenu`.

Right now the only user-visible connection toggle is Notion. The toggle state is
kept in `AgentChatShell` as:

```ts
enabledConnections = { notion: true };
```

When a message is sent, the app passes a natural-language `clientContext` to
eve:

```ts
createConnectionClientContext(enabledConnections);
```

If a connection is enabled, the context tells eve which of Notion, Linear, and
Sentry the user enabled for this turn. Disabled connections are called out so
the model does not use them unless the user enables them first.

This toggle does not provision, create, or revoke a Vercel Connect connector. It
only controls per-turn agent behavior.

The actual MCP connectors are configured in `agent/connections/*.ts`. For
example, Notion is configured in `agent/connections/notion.ts`:

```ts
const notionConnector = process.env.NOTION_CONNECTOR ?? "notion";

export default defineMcpClientConnection({
  url: "https://mcp.notion.com/mcp",
  description: "Notion workspace: search and edit pages and databases.",
  auth: connect(notionConnector),
});
```

For production, set `NOTION_CONNECTOR`, `LINEAR_CONNECTOR`, and
`SENTRY_CONNECTOR` to the returned Vercel Connect connector UIDs. For local
development, connectors created with `--name notion`, `--name linear`, and
`--name sentry` match the fallback names.

## Auth

Starter mode uses a shared deployment password. The login route verifies
`EVE_CHAT_PASSWORD` and issues a signed, HTTP-only, same-site cookie without a
database. `apps/web/lib/session.ts` and `apps/web/lib/eve-auth.ts` verify the same cookie for the
Next.js UI and eve route boundary.

Production mode uses Better Auth with Sign in with Vercel.

`apps/web/lib/auth-url.ts` resolves the base app URL in this order:

1. `BETTER_AUTH_URL`
2. `VERCEL_PROJECT_PRODUCTION_URL`
3. `VERCEL_URL`
4. `http://localhost:3000`

`apps/web/lib/auth.ts` configures Better Auth with:

- Drizzle adapter
- encrypted OAuth tokens
- Vercel social provider
- required scopes: `openid`, `email`, `profile`
- `/auth/error` as the error page

`apps/web/lib/session.ts` returns a safe `Viewer` object for server components. It returns
the shared starter viewer, local development viewer, or Vercel user depending
on the selected mode.

`apps/web/lib/eve-auth.ts` adapts the selected app session into an eve channel principal.
Production mode uses:

```ts
{
  principalType: "user",
  principalId: session.user.id,
  subject: session.user.email,
  attributes: {
    email: session.user.email,
    name: session.user.name,
  },
}
```

`agent/channels/eve.ts` allows:

- `betterAuthEveAuth`
- `passwordEveAuth`
- `vercelOidc()`
- `localDev()`

That lets the same channel work locally, in authenticated browser sessions, and
with Vercel OIDC contexts.

## Setup Readiness

`apps/web/lib/setup.ts` produces a `SetupStatus` object:

```ts
type SetupStatus = {
  appReady: boolean;
  authMode: "local-dev" | "password" | "unconfigured" | "vercel";
  authReady: boolean;
  databaseConfigured: boolean;
  databaseReady: boolean;
  databaseSchemaReady: boolean;
  missing: readonly string[];
  rateLimitReady: boolean;
  storageMode: "browser" | "database";
};
```

The starter is ready when `EVE_CHAT_PASSWORD` is non-empty. A strong value with
16+ characters is recommended. Local development is ready on loopback without
configuration. Production mode is
selected when all of these are configured:

- `DATABASE_URL` exists
- database migrations have created the expected tables
- Better Auth env vars are present
- Upstash Redis env vars are present

Production mode then checks whether these Postgres tables exist:

- `account`
- `chat`
- `chat_event`
- `session`
- `user`
- `verification`

The UI uses setup status in three places:

1. Root composer disabled state
2. Session composer disabled state
3. Sidebar auth/sign-in controls

Disabled composers should always provide a reason through tooltip text.

## Rate Limiting

Production-mode rate limiting uses Upstash Redis in `apps/web/lib/rate-limit.ts`.

The app supports either current Upstash env names:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

or legacy Vercel KV env names:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

`enforceRateLimit` uses a fixed window key:

```txt
rate:<prefix>:<viewer id>:<window id>
```

The current send limits are:

- `chat:create`: 25 per hour
- `chat:send`: 25 per hour
- Message length: 8,000 characters

The create and send limits are separate so creating a chat and then sending a
message can be guarded independently. Message length is enforced in the
composer and again in server actions before creating chats or saving pending
messages.

## Message Rendering

`useEveAgent` reduces stream events into message data. The template renders that
data through `apps/web/components/chat/message.tsx`.

Message rendering supports:

- user bubbles
- assistant markdown through Streamdown
- reasoning parts
- tool parts
- tool input/response UI
- optimistic pending user messages
- a separate "Thinking..." presence row

User messages are rendered as rounded, compact bubbles aligned to the right.
Assistant messages are full-width text on the left.

Tool calls are grouped so a sequence of tool parts appears as one
compact row. Tool rows can be expanded only when they have useful details or
input controls. A row's status comes from the tool part, not from whether later
assistant text exists or the turn is still streaming. Labels come from eve's
`part.label` rather than guesses based on tool inputs.

Reasoning parts render as a collapsible block. While streaming, the label says
"Thinking..." and uses shimmer text. Reply carets follow the text part's own
streaming state, so completed text does not keep a caret while other work runs.

The standalone `ThinkingMessage` appears when the session is busy but there is
not yet enough assistant text to make progress feel visible, or while a response
is still active. It fades out instead of disappearing abruptly.

## Composer Behavior

`apps/web/components/chat/composer.tsx` is controlled by the page:

- `value`
- `onChange`
- `onSubmit`
- `disabled`
- `disabledReason`
- `isBusy`
- `isPreparing`

The composer:

- auto-focuses when enabled
- submits on Enter
- inserts a newline on Shift+Enter
- disables while a request is in flight
- shows a stop button when eve is busy
- shows a spinner when the root page is creating a chat
- wraps disabled states in a tooltip

Root and session pages render the same composer component, but they place it
differently:

- root page: centered with the eve logo
- session page: pinned near the bottom of the chat route

This separation prevents root route layout from briefly looking like a session
route and vice versa.

## Error Handling

User-visible request failures render as `ErrorToast`, not inline layout blocks.
That keeps errors from pushing the composer or chat body around.

Common setup errors:

- missing or short `EVE_CHAT_PASSWORD` in starter mode
- incomplete Neon, Better Auth/Vercel OAuth, or Upstash configuration
- production migrations not run
- Vercel OAuth app missing the `email` scope

Common stream errors:

- stream disconnected before a settled event
- eve session missing when trying to resume
- authorization callback not pending
- rate limit exceeded

The app generally prefers:

- toast for recoverable request failures
- disabled composer with tooltip for setup blockers
- structured auth cards for connection blockers

## Event Log Invariants

These invariants are important:

1. `chat_event.eventIndex` must be unique per chat.
2. A completed snapshot should overwrite stale event rows by index.
3. A snapshot must not truncate newer event rows.
4. `pendingUserMessage` should be cleared after a response boundary.
5. Persist only authoritative events from the hook; do not synthesize settlements.
6. A pending authorization should disable normal text input for that session.
7. A route change should reset per-chat refs such as event index and local
   pending messages.
8. Sidebar history should update optimistically, but the event log remains the
   source of truth for chat content.

When debugging "messages replaced old messages" or "a response updated after it
looked complete", inspect these pieces first:

- whether two events were written to the same local `eventIndex`
- whether writes reached storage in event order, with cursors following their events
- whether `pendingUserMessage` was left on the chat row after a settled event
- whether the eve stream ended its turn (`turn.settled`) before the UI expected it
- whether a local optimistic message was cleared before the real user event
  appeared

## Adding A New Tool

To add a local eve tool:

1. Create a file in `agent/tools/`.
2. Export a `defineTool(...)`.
3. Import/register it according to eve's agent conventions.
4. Update `agent/instructions.md` so the agent knows when to use it.
5. If the UI should render a special tool state, update
   `apps/web/components/chat/message.tsx`.

Keep tool output structured. The message renderer can make much better UI
decisions when tool parts contain predictable JSON instead of prose-only output.

## Adding A New Connection

To add another Vercel Connect-backed MCP connection:

1. Add `agent/connections/<name>.ts`.
2. Use `defineMcpClientConnection`.
3. Use `connect(process.env.<ENV_NAME> ?? "<local-name>")`.
4. Add deploy/docs instructions for provisioning that connector.
5. Extend `EnabledConnections` in `chat-shell-context.tsx`.
6. Add a toggle in `IntegrationsMenu`.
7. Update `createConnectionClientContext` so eve receives per-turn intent.
8. Verify auth-required events render correctly.

Do not parse assistant text to detect auth requirements. Rely on
sign-in `interaction.opened` and `interaction.settled` events.

## Adding A New Channel

This template exposes a web chat channel through `agent/channels/eve.ts`, a
Slack channel through `agent/channels/slack.ts`, and the peer Next.js service composed with eve in `vercel.ts`.

If you add another channel, keep this separation:

- channel-specific webhook or transport code belongs in `agent/channels/`
- web chat UI state belongs in `apps/web/app/_components/` and `apps/web/components/chat/`
- cross-channel agent behavior belongs in `agent/instructions.md`, tools, and
  connections

The web chat persistence code is intentionally tied to the browser experience.
Do not reuse it as a generic state adapter for every channel without checking
the other channel's message and session semantics.

## Development Checklist

When making changes to the chat flow, verify:

1. Root page renders without layout shift.
2. Unauthenticated users can type, then are prompted to sign in.
3. First message creates a chat and appears immediately after navigation.
4. Follow-up messages appear optimistically.
5. Assistant text streams without replacing older messages.
6. Refreshing mid-response resumes or ends with a clear error.
7. Sidebar history remains visible and active row state is correct.
8. Sidebar pagination still loads older chats.
9. Pending authorization disables only the affected session.
10. Connect and Skip both leave the conversation in a usable state.
11. Setup blockers show tooltips or actionable auth/setup pages.
12. `pnpm typecheck` and `pnpm build` pass.

## Mental Model

Think of the app as a small durable chat runtime:

```mermaid
flowchart TD
  User["User submits text"] --> Composer["ChatComposer"]
  Composer --> Page["HomeChatPage or SessionChatPage"]
  Page --> Controller["AgentChatSession controller"]
  Controller --> Pending["Mark pendingUserMessage"]
  Pending --> EvePost["POST /eve/v1/session"]
  EvePost --> Stream["GET /eve/v1/session/:id/stream"]
  Stream --> EventRows["append chat_event rows"]
  Stream --> UI["useEveAgent renders messages"]
  UI --> Snapshot["Shared-state boundary saves full snapshot"]
  Snapshot --> ChatRow["chat.eveSession and pending cleared"]
  ChatRow --> Sidebar["touchChat updates sidebar"]
```

The browser is allowed to be interrupted. Postgres keeps enough state to rebuild
the UI and continue from eve's stream cursor. The static shell keeps navigation
smooth. The final snapshot keeps the event log canonical.

That is the core design.
