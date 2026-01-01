# Claude Agent SDK Hello World

A simple example demonstrating how to use the Claude Agent SDK to create autonomous agents that can interact with Claude.

## Overview

The Claude Agent SDK allows you to programmatically build AI agents with Claude's capabilities. The SDK spawns a Claude Code process as a subprocess and communicates with it to execute tasks autonomously.

## Installation

```bash
npm install @anthropic-ai/claude-agent-sdk typescript @types/node tsx zod
```

## Setup

1. Set your Anthropic API key as an environment variable:
```bash
export ANTHROPIC_API_KEY="your-api-key"
```

2. Create the required directory structure:
```bash
mkdir -p agent/custom_scripts
```

The `agent` directory is used as the working directory for the Claude agent, and `custom_scripts` is where JavaScript/TypeScript files must be written (enforced by the hook in the example).

## How It Works

### Basic Structure

The SDK uses a `query()` function that returns an async iterable of messages:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt: 'Your prompt here',
  options: { /* configuration */ }
});

for await (const message of q) {
  // Process messages
}
```

### Key Components

#### 1. Query Options

- **`maxTurns`**: Maximum number of conversation turns (default: 100)
- **`cwd`**: Working directory for the agent (must exist)
- **`model`**: Claude model to use (`"sonnet"`, `"opus"`, `"haiku"`, or `"inherit"`)
- **`executable`**: Path to Node.js binary (use `process.execPath` for current runtime)
- **`allowedTools`**: Array of tool names the agent can use

#### 2. Available Tools

The agent can use various tools including:
- **File operations**: `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`
- **Search**: `Glob`, `Grep`, `WebSearch`
- **Execution**: `Bash`, `Task`
- **Utilities**: `TodoWrite`, `WebFetch`, `BashOutput`, `KillBash`
- **Planning**: `ExitPlanMode`

#### 3. Hooks

Hooks allow you to intercept and control tool usage. The example includes a `PreToolUse` hook that enforces that `.js` and `.ts` files can only be written to the `custom_scripts` directory:

```typescript
hooks: {
  PreToolUse: [
    {
      matcher: "Write|Edit|MultiEdit",
      hooks: [
        async (input: any): Promise<HookJSONOutput> => {
          // Validation logic
          // Return { continue: true } to allow
          // Return { decision: 'block', stopReason: '...', continue: false } to deny
        }
      ]
    }
  ]
}
```

#### 4. Message Types

The SDK returns three types of messages:

- **`system`**: System-level messages and prompts
- **`assistant`**: Claude's responses (contains the actual message content)
- **`result`**: Tool execution results

To extract Claude's text response:

```typescript
if (message.type === 'assistant' && message.message) {
  const textContent = message.message.content.find((c: any) => c.type === 'text');
  if (textContent && 'text' in textContent) {
    console.log(textContent.text);
  }
}
```

### Architecture

1. The SDK spawns a Claude Code CLI process as a subprocess
2. It uses the Node.js binary specified in `executable` (defaults to `"node"`)
3. Communication happens via stdin/stdout with the subprocess
4. The agent runs in the specified `cwd` directory
5. Hooks can intercept and modify tool calls before execution

## Running the Example

```bash
npx tsx hello-world.ts
```

## Common Issues

### "Failed to spawn Claude Code process: spawn node ENOENT"

**Solution**: Set the `executable` option to `node`:

```typescript
options: {
  executable: "node",
  // ... other options
}
```

### "ENOENT" errors on spawn

**Solution**: Ensure the `cwd` directory exists:

```bash
mkdir -p agent
```

### Permission errors for file operations

**Solution**: Check your hooks configuration and ensure the agent has the necessary `allowedTools`.

## Resources

- [Claude Agent SDK Documentation](https://docs.claude.com/en/api/agent-sdk/overview)
- [GitHub Repository](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Anthropic Engineering Blog](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
# claude-agent-hello-world
