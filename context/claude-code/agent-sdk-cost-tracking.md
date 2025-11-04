 For tracking costs and tokens in your Agent SDK plugin, you have built-in programmatic access to usage data through the SDK itself[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking).

## Agent SDK Cost Tracking

The Claude Agent SDK provides detailed token usage information for each interaction[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking). Here's how to track it:

**TypeScript:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = await query({
  prompt: "Your task here",
  options: {
    onMessage: (message) => {
      if (message.type === 'assistant' && message.usage) {
        console.log(`Message ID: ${message.id}`);
        console.log(`Usage:`, message.usage);
      }
    }
  }
});
```
[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking)

The final `result` message contains the total cumulative usage from all steps in the conversation[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking):

```typescript
console.log("Total usage:", result.usage);
console.log("Total cost:", result.usage.total_cost_usd);
```
[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking)

## Important: Avoid Double-Counting

When Claude executes tools in parallel, multiple assistant messages may share the same ID and usage data[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking). You should only charge once per unique message ID[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking):

```typescript
const processedMessageIds = new Set<string>();

onMessage: (message) => {
  if (message.type === 'assistant' && message.usage) {
    // Skip if already processed
    if (processedMessageIds.has(message.id)) {
      return;
    }
    
    processedMessageIds.add(message.id);
    // Record usage here
  }
}
```
[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking)

## Usage Fields

Each usage object contains[(1)](https://docs.claude.com/en/api/agent-sdk/cost-tracking):
- `input_tokens`: Base input tokens processed
- `output_tokens`: Tokens generated in the response
- `cache_creation_input_tokens`: Tokens used to create cache entries
- `cache_read_input_tokens`: Tokens read from cache
- `total_cost_usd`: Total cost in USD (only in result message)
