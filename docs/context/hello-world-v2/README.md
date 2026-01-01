# Claude Agent SDK V2 Examples

Examples for the **V2 Session API** (`unstable_v2_*`).

## V1 vs V2

| V1: `query()` | V2: Session API |
|---------------|-----------------|
| Async generator of all messages | Separate `send()` / `receive()` |
| Single prompt flow | Multi-turn conversations |
| `for await (msg of query({prompt}))` | `await session.send()` then `for await (msg of session.receive())` |

## Quick Start

```bash
npm install
npx tsx v2-examples.ts basic       # Basic session
npx tsx v2-examples.ts multi-turn  # Multi-turn conversation
npx tsx v2-examples.ts one-shot    # unstable_v2_prompt()
npx tsx v2-examples.ts resume      # Session persistence
```

## API

```typescript
// Create session (auto-closes with await using)
await using session = unstable_v2_createSession({ model: 'sonnet' });
await session.send('Hello!');
for await (const msg of session.receive()) { /* ... */ }

// Resume session
await using session = unstable_v2_resumeSession(sessionId, { model: 'sonnet' });

// One-shot (returns result directly)
const result = await unstable_v2_prompt('Question?', { model: 'sonnet' });
```
