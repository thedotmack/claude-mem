# Agent SDK V2 API Reference

The `unstable_v2_*` APIs from `@anthropic-ai/claude-agent-sdk` are the session-based V2 interface.

Source: https://docs.anthropic.com/en/docs/claude-code/agent-sdk/typescript-v2

## Official Pattern (from Anthropic docs)

```typescript
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk'

await using session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929'
})

await session.send('Hello!')
for await (const msg of session.receive()) {
  if (msg.type === 'assistant') {
    // Official text extraction pattern: filter/map/join
    const text = msg.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    console.log(text)
  }
}
```

## Key APIs

- `unstable_v2_createSession({ model })` - Creates a new session
- `unstable_v2_resumeSession(sessionId, { model })` - Resumes existing session
- `session.send(message)` - Send a message
- `session.receive()` - Async iterator for responses (NOT `stream()`)
- `session.close()` - Manual cleanup (or use `await using`)

## Text Extraction Pattern

The official docs use `.filter().map().join()`:
```typescript
const text = msg.message.content
  .filter(block => block.type === 'text')
  .map(block => block.text)
  .join('')
```

Do NOT use `.find()` with type guards - that's not in the official examples.

## Token Usage

- `unstable_v2_prompt()` (one-shot) returns `result.total_cost_usd`
- Session-based API (`send/receive`) does NOT expose token usage
