# Hooks reference

> This page provides reference documentation for implementing hooks in Claude Code.

<Tip>
  For a quickstart guide with examples, see [Get started with Claude Code hooks](/en/hooks-guide).
</Tip>

## Configuration

Claude Code hooks are configured in your [settings files](/en/settings):

* `~/.claude/settings.json` - User settings
* `.claude/settings.json` - Project settings
* `.claude/settings.local.json` - Local project settings (not committed)
* Enterprise managed policy settings

### Structure

Hooks are organized by matchers, where each matcher can have multiple hooks:

```json  theme={null}
{
  "hooks": {
    "EventName": [
      {
        "matcher": "ToolPattern",
        "hooks": [
          {
            "type": "command",
            "command": "your-command-here"
          }
        ]
      }
    ]
  }
}
```

* **matcher**: Pattern to match tool names, case-sensitive (only applicable for
  `PreToolUse` and `PostToolUse`)
  * Simple strings match exactly: `Write` matches only the Write tool
  * Supports regex: `Edit|Write` or `Notebook.*`
  * Use `*` to match all tools. You can also use empty string (`""`) or leave
    `matcher` blank.
* **hooks**: Array of hooks to execute when the pattern matches
  * `type`: Hook execution type - `"command"` for bash commands or `"prompt"` for LLM-based evaluation
  * `command`: (For `type: "command"`) The bash command to execute (can use `$CLAUDE_PROJECT_DIR` environment variable)
  * `prompt`: (For `type: "prompt"`) The prompt to send to the LLM for evaluation
  * `timeout`: (Optional) How long a hook should run, in seconds, before canceling that specific hook

For events like `UserPromptSubmit`, `Notification`, `Stop`, and `SubagentStop`
that don't use matchers, you can omit the matcher field:

```json  theme={null}
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/prompt-validator.py"
          }
        ]
      }
    ]
  }
}
```

### Project-Specific Hook Scripts

You can use the environment variable `CLAUDE_PROJECT_DIR` (only available when
Claude Code spawns the hook command) to reference scripts stored in your project,
ensuring they work regardless of Claude's current directory:

```json  theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check-style.sh"
          }
        ]
      }
    ]
  }
}
```

### Plugin hooks

[Plugins](/en/plugins) can provide hooks that integrate seamlessly with your user and project hooks. Plugin hooks are automatically merged with your configuration when plugins are enabled.

**How plugin hooks work**:

* Plugin hooks are defined in the plugin's `hooks/hooks.json` file or in a file given by a custom path to the `hooks` field.
* When a plugin is enabled, its hooks are merged with user and project hooks
* Multiple hooks from different sources can respond to the same event
* Plugin hooks use the `${CLAUDE_PLUGIN_ROOT}` environment variable to reference plugin files

**Example plugin hook configuration**:

```json  theme={null}
{
  "description": "Automatic code formatting",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

<Note>
  Plugin hooks use the same format as regular hooks with an optional `description` field to explain the hook's purpose.
</Note>

<Note>
  Plugin hooks run alongside your custom hooks. If multiple hooks match an event, they all execute in parallel.
</Note>

**Environment variables for plugins**:

* `${CLAUDE_PLUGIN_ROOT}`: Absolute path to the plugin directory
* `${CLAUDE_PROJECT_DIR}`: Project root directory (same as for project hooks)
* All standard environment variables are available

See the [plugin components reference](/en/plugins-reference#hooks) for details on creating plugin hooks.

## Prompt-Based Hooks

In addition to bash command hooks (`type: "command"`), Claude Code supports prompt-based hooks (`type: "prompt"`) that use an LLM to evaluate whether to allow or block an action. Prompt-based hooks are currently only supported for `Stop` and `SubagentStop` hooks, where they enable intelligent, context-aware decisions.

### How prompt-based hooks work

Instead of executing a bash command, prompt-based hooks:

1. Send the hook input and your prompt to a fast LLM (Haiku)
2. The LLM responds with structured JSON containing a decision
3. Claude Code processes the decision automatically

### Configuration

```json  theme={null}
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if Claude should stop: $ARGUMENTS. Check if all tasks are complete."
          }
        ]
      }
    ]
  }
}
```

**Fields:**

* `type`: Must be `"prompt"`
* `prompt`: The prompt text to send to the LLM
  * Use `$ARGUMENTS` as a placeholder for the hook input JSON
  * If `$ARGUMENTS` is not present, input JSON is appended to the prompt
* `timeout`: (Optional) Timeout in seconds (default: 30 seconds)

### Response schema

The LLM must respond with JSON containing:

```json  theme={null}
{
  "decision": "approve" | "block",
  "reason": "Explanation for the decision",
  "continue": false,  // Optional: stops Claude entirely
  "stopReason": "Message shown to user",  // Optional: custom stop message
  "systemMessage": "Warning or context"  // Optional: shown to user
}
```

**Response fields:**

* `decision`: `"approve"` allows the action, `"block"` prevents it
* `reason`: Explanation shown to Claude when decision is `"block"`
* `continue`: (Optional) If `false`, stops Claude's execution entirely
* `stopReason`: (Optional) Message shown when `continue` is false
* `systemMessage`: (Optional) Additional message shown to the user

### Supported hook events

Prompt-based hooks work with any hook event, but are most useful for:

* **Stop**: Intelligently decide if Claude should continue working
* **SubagentStop**: Evaluate if a subagent has completed its task
* **UserPromptSubmit**: Validate user prompts with LLM assistance
* **PreToolUse**: Make context-aware permission decisions

### Example: Intelligent Stop hook

```json  theme={null}
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "You are evaluating whether Claude should stop working. Context: $ARGUMENTS\n\nAnalyze the conversation and determine if:\n1. All user-requested tasks are complete\n2. Any errors need to be addressed\n3. Follow-up work is needed\n\nRespond with JSON: {\"decision\": \"approve\" or \"block\", \"reason\": \"your explanation\"}",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Example: SubagentStop with custom logic

```json  theme={null}
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if this subagent should stop. Input: $ARGUMENTS\n\nCheck if:\n- The subagent completed its assigned task\n- Any errors occurred that need fixing\n- Additional context gathering is needed\n\nReturn: {\"decision\": \"approve\" or \"block\", \"reason\": \"explanation\"}"
          }
        ]
      }
    ]
  }
}
```

### Comparison with bash command hooks

| Feature               | Bash Command Hooks      | Prompt-Based Hooks             |
| --------------------- | ----------------------- | ------------------------------ |
| **Execution**         | Runs bash script        | Queries LLM                    |
| **Decision logic**    | You implement in code   | LLM evaluates context          |
| **Setup complexity**  | Requires script file    | Just configure prompt          |
| **Context awareness** | Limited to script logic | Natural language understanding |
| **Performance**       | Fast (local execution)  | Slower (API call)              |
| **Use case**          | Deterministic rules     | Context-aware decisions        |

### Best practices

* **Be specific in prompts**: Clearly state what you want the LLM to evaluate
* **Include decision criteria**: List the factors the LLM should consider
* **Test your prompts**: Verify the LLM makes correct decisions for your use cases
* **Set appropriate timeouts**: Default is 30 seconds, adjust if needed
* **Use for complex decisions**: Bash hooks are better for simple, deterministic rules

See the [plugin components reference](/en/plugins-reference#hooks) for details on creating plugin hooks.

## Hook Events

### PreToolUse

Runs after Claude creates tool parameters and before processing the tool call.

**Common matchers:**

* `Task` - Subagent tasks (see [subagents documentation](/en/sub-agents))
* `Bash` - Shell commands
* `Glob` - File pattern matching
* `Grep` - Content search
* `Read` - File reading
* `Edit` - File editing
* `Write` - File writing
* `WebFetch`, `WebSearch` - Web operations

### PostToolUse

Runs immediately after a tool completes successfully.

Recognizes the same matcher values as PreToolUse.

### Notification

Runs when Claude Code sends notifications. Notifications are sent when:

1. Claude needs your permission to use a tool. Example: "Claude needs your
   permission to use Bash"
2. The prompt input has been idle for at least 60 seconds. "Claude is waiting
   for your input"

### UserPromptSubmit

Runs when the user submits a prompt, before Claude processes it. This allows you
to add additional context based on the prompt/conversation, validate prompts, or
block certain types of prompts.

### Stop

Runs when the main Claude Code agent has finished responding. Does not run if
the stoppage occurred due to a user interrupt.

### SubagentStop

Runs when a Claude Code subagent (Task tool call) has finished responding.

### PreCompact

Runs before Claude Code is about to run a compact operation.

**Matchers:**

* `manual` - Invoked from `/compact`
* `auto` - Invoked from auto-compact (due to full context window)

### SessionStart

Runs when Claude Code starts a new session or resumes an existing session (which
currently does start a new session under the hood). Useful for loading in
development context like existing issues or recent changes to your codebase, installing dependencies, or setting up environment variables.

**Matchers:**

* `startup` - Invoked from startup
* `resume` - Invoked from `--resume`, `--continue`, or `/resume`
* `clear` - Invoked from `/clear`
* `compact` - Invoked from auto or manual compact.

#### Persisting environment variables

SessionStart hooks have access to the `CLAUDE_ENV_FILE` environment variable, which provides a file path where you can persist environment variables for subsequent bash commands.

**Example: Setting individual environment variables**

```bash  theme={null}
#!/bin/bash

if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo 'export NODE_ENV=production' >> "$CLAUDE_ENV_FILE"
  echo 'export API_KEY=your-api-key' >> "$CLAUDE_ENV_FILE"
  echo 'export PATH="$PATH:./node_modules/.bin"' >> "$CLAUDE_ENV_FILE"
fi

exit 0
```

**Example: Persisting all environment changes from the hook**

When your setup modifies the environment (e.g., `nvm use`), capture and persist all changes by diffing the environment:

```bash  theme={null}
#!/bin/bash

ENV_BEFORE=$(export -p | sort)

# Run your setup commands that modify the environment
source ~/.nvm/nvm.sh
nvm use 20

if [ -n "$CLAUDE_ENV_FILE" ]; then
  ENV_AFTER=$(export -p | sort)
  comm -13 <(echo "$ENV_BEFORE") <(echo "$ENV_AFTER") >> "$CLAUDE_ENV_FILE"
fi

exit 0
```

Any variables written to this file will be available in all subsequent bash commands that Claude Code executes during the session.

<Note>
  `CLAUDE_ENV_FILE` is only available for SessionStart hooks. Other hook types do not have access to this variable.
</Note>

### SessionEnd

Runs when a Claude Code session ends. Useful for cleanup tasks, logging session
statistics, or saving session state.

The `reason` field in the hook input will be one of:

* `clear` - Session cleared with /clear command
* `logout` - User logged out
* `prompt_input_exit` - User exited while prompt input was visible
* `other` - Other exit reasons

## Hook Input

Hooks receive JSON data via stdin containing session information and
event-specific data:

```typescript  theme={null}
{
  // Common fields
  session_id: string
  transcript_path: string  // Path to conversation JSON
  cwd: string              // The current working directory when the hook is invoked
  permission_mode: string  // Current permission mode: "default", "plan", "acceptEdits", or "bypassPermissions"

  // Event-specific fields
  hook_event_name: string
  ...
}
```

### PreToolUse Input

The exact schema for `tool_input` depends on the tool.

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  }
}
```

### PostToolUse Input

The exact schema for `tool_input` and `tool_response` depends on the tool.

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "PostToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.txt",
    "content": "file content"
  },
  "tool_response": {
    "filePath": "/path/to/file.txt",
    "success": true
  }
}
```

### Notification Input

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "Notification",
  "message": "Task completed successfully"
}
```

### UserPromptSubmit Input

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Write a function to calculate the factorial of a number"
}
```

### Stop and SubagentStop Input

`stop_hook_active` is true when Claude Code is already continuing as a result of
a stop hook. Check this value or process the transcript to prevent Claude Code
from running indefinitely.

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": true
}
```

### PreCompact Input

For `manual`, `custom_instructions` comes from what the user passes into
`/compact`. For `auto`, `custom_instructions` is empty.

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "PreCompact",
  "trigger": "manual",
  "custom_instructions": ""
}
```

### SessionStart Input

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "permission_mode": "default",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

### SessionEnd Input

```json  theme={null}
{
  "session_id": "abc123",
  "transcript_path": "~/.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/Users/...",
  "permission_mode": "default",
  "hook_event_name": "SessionEnd",
  "reason": "exit"
}
```

## Hook Output

There are two ways for hooks to return output back to Claude Code. The output
communicates whether to block and any feedback that should be shown to Claude
and the user.

### Simple: Exit Code

Hooks communicate status through exit codes, stdout, and stderr:

* **Exit code 0**: Success. `stdout` is shown to the user in transcript mode
  (CTRL-R), except for `UserPromptSubmit` and `SessionStart`, where stdout is
  added to the context.
* **Exit code 2**: Blocking error. `stderr` is fed back to Claude to process
  automatically. See per-hook-event behavior below.
* **Other exit codes**: Non-blocking error. `stderr` is shown to the user and
  execution continues.

<Warning>
  Reminder: Claude Code does not see stdout if the exit code is 0, except for
  the `UserPromptSubmit` hook where stdout is injected as context.
</Warning>

#### Exit Code 2 Behavior

| Hook Event         | Behavior                                                           |
| ------------------ | ------------------------------------------------------------------ |
| `PreToolUse`       | Blocks the tool call, shows stderr to Claude                       |
| `PostToolUse`      | Shows stderr to Claude (tool already ran)                          |
| `Notification`     | N/A, shows stderr to user only                                     |
| `UserPromptSubmit` | Blocks prompt processing, erases prompt, shows stderr to user only |
| `Stop`             | Blocks stoppage, shows stderr to Claude                            |
| `SubagentStop`     | Blocks stoppage, shows stderr to Claude subagent                   |
| `PreCompact`       | N/A, shows stderr to user only                                     |
| `SessionStart`     | N/A, shows stderr to user only                                     |
| `SessionEnd`       | N/A, shows stderr to user only                                     |

### Advanced: JSON Output

Hooks can return structured JSON in `stdout` for more sophisticated control:

#### Common JSON Fields

All hook types can include these optional fields:

```json  theme={null}
{
  "continue": true, // Whether Claude should continue after hook execution (default: true)
  "stopReason": "string", // Message shown when continue is false

  "suppressOutput": true, // Hide stdout from transcript mode (default: false)
  "systemMessage": "string" // Optional warning message shown to the user
}
```

If `continue` is false, Claude stops processing after the hooks run.

* For `PreToolUse`, this is different from `"permissionDecision": "deny"`, which
  only blocks a specific tool call and provides automatic feedback to Claude.
* For `PostToolUse`, this is different from `"decision": "block"`, which
  provides automated feedback to Claude.
* For `UserPromptSubmit`, this prevents the prompt from being processed.
* For `Stop` and `SubagentStop`, this takes precedence over any
  `"decision": "block"` output.
* In all cases, `"continue" = false` takes precedence over any
  `"decision": "block"` output.

`stopReason` accompanies `continue` with a reason shown to the user, not shown
to Claude.

#### `PreToolUse` Decision Control

`PreToolUse` hooks can control whether a tool call proceeds.

* `"allow"` bypasses the permission system. `permissionDecisionReason` is shown
  to the user but not to Claude.
* `"deny"` prevents the tool call from executing. `permissionDecisionReason` is
  shown to Claude.
* `"ask"` asks the user to confirm the tool call in the UI.
  `permissionDecisionReason` is shown to the user but not to Claude.

Additionally, hooks can modify tool inputs before execution using `updatedInput`:

* `updatedInput` allows you to modify the tool's input parameters before the tool executes. This is a `Record<string, unknown>` object containing the fields you want to change or add.
* This is most useful with `"permissionDecision": "allow"` to modify and approve tool calls.

```json  theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
    "permissionDecisionReason": "My reason here",
    "updatedInput": {
      "field_to_modify": "new value"
    }
  }
}
```

<Note>
  The `decision` and `reason` fields are deprecated for PreToolUse hooks.
  Use `hookSpecificOutput.permissionDecision` and
  `hookSpecificOutput.permissionDecisionReason` instead. The deprecated fields
  `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively.
</Note>

#### `PostToolUse` Decision Control

`PostToolUse` hooks can provide feedback to Claude after tool execution.

* `"block"` automatically prompts Claude with `reason`.
* `undefined` does nothing. `reason` is ignored.
* `"hookSpecificOutput.additionalContext"` adds context for Claude to consider.

```json  theme={null}
{
  "decision": "block" | undefined,
  "reason": "Explanation for decision",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Additional information for Claude"
  }
}
```

#### `UserPromptSubmit` Decision Control

`UserPromptSubmit` hooks can control whether a user prompt is processed.

* `"block"` prevents the prompt from being processed. The submitted prompt is
  erased from context. `"reason"` is shown to the user but not added to context.
* `undefined` allows the prompt to proceed normally. `"reason"` is ignored.
* `"hookSpecificOutput.additionalContext"` adds the string to the context if not
  blocked.

```json  theme={null}
{
  "decision": "block" | undefined,
  "reason": "Explanation for decision",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "My additional context here"
  }
}
```

#### `Stop`/`SubagentStop` Decision Control

`Stop` and `SubagentStop` hooks can control whether Claude must continue.

* `"block"` prevents Claude from stopping. You must populate `reason` for Claude
  to know how to proceed.
* `undefined` allows Claude to stop. `reason` is ignored.

```json  theme={null}
{
  "decision": "block" | undefined,
  "reason": "Must be provided when Claude is blocked from stopping"
}
```

#### `SessionStart` Decision Control

`SessionStart` hooks allow you to load in context at the start of a session.

* `"hookSpecificOutput.additionalContext"` adds the string to the context.
* Multiple hooks' `additionalContext` values are concatenated.

```json  theme={null}
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "My additional context here"
  }
}
```

#### `SessionEnd` Decision Control

`SessionEnd` hooks run when a session ends. They cannot block session termination
but can perform cleanup tasks.

#### Exit Code Example: Bash Command Validation

```python  theme={null}
#!/usr/bin/env python3
import json
import re
import sys

# Define validation rules as a list of (regex pattern, message) tuples
VALIDATION_RULES = [
    (
        r"\bgrep\b(?!.*\|)",
        "Use 'rg' (ripgrep) instead of 'grep' for better performance and features",
    ),
    (
        r"\bfind\s+\S+\s+-name\b",
        "Use 'rg --files | rg pattern' or 'rg --files -g pattern' instead of 'find -name' for better performance",
    ),
]


def validate_command(command: str) -> list[str]:
    issues = []
    for pattern, message in VALIDATION_RULES:
        if re.search(pattern, command):
            issues.append(message)
    return issues


try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
    sys.exit(1)

tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})
command = tool_input.get("command", "")

if tool_name != "Bash" or not command:
    sys.exit(1)

# Validate the command
issues = validate_command(command)

if issues:
    for message in issues:
        print(f"• {message}", file=sys.stderr)
    # Exit code 2 blocks tool call and shows stderr to Claude
    sys.exit(2)
```

#### JSON Output Example: UserPromptSubmit to Add Context and Validation

<Note>
  For `UserPromptSubmit` hooks, you can inject context using either method:

  * Exit code 0 with stdout: Claude sees the context (special case for `UserPromptSubmit`)
  * JSON output: Provides more control over the behavior
</Note>

```python  theme={null}
#!/usr/bin/env python3
import json
import sys
import re
import datetime

# Load input from stdin
try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
    sys.exit(1)

prompt = input_data.get("prompt", "")

# Check for sensitive patterns
sensitive_patterns = [
    (r"(?i)\b(password|secret|key|token)\s*[:=]", "Prompt contains potential secrets"),
]

for pattern, message in sensitive_patterns:
    if re.search(pattern, prompt):
        # Use JSON output to block with a specific reason
        output = {
            "decision": "block",
            "reason": f"Security policy violation: {message}. Please rephrase your request without sensitive information."
        }
        print(json.dumps(output))
        sys.exit(0)

# Add current time to context
context = f"Current time: {datetime.datetime.now()}"
print(context)

"""
The following is also equivalent:
print(json.dumps({
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": context,
  },
}))
"""

# Allow the prompt to proceed with the additional context
sys.exit(0)
```

#### JSON Output Example: PreToolUse with Approval

```python  theme={null}
#!/usr/bin/env python3
import json
import sys

# Load input from stdin
try:
    input_data = json.load(sys.stdin)
except json.JSONDecodeError as e:
    print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
    sys.exit(1)

tool_name = input_data.get("tool_name", "")
tool_input = input_data.get("tool_input", {})

# Example: Auto-approve file reads for documentation files
if tool_name == "Read":
    file_path = tool_input.get("file_path", "")
    if file_path.endswith((".md", ".mdx", ".txt", ".json")):
        # Use JSON output to auto-approve the tool call
        output = {
            "decision": "approve",
            "reason": "Documentation file auto-approved",
            "suppressOutput": True  # Don't show in transcript mode
        }
        print(json.dumps(output))
        sys.exit(0)

# For other cases, let the normal permission flow proceed
sys.exit(0)
```

## Working with MCP Tools

Claude Code hooks work seamlessly with
[Model Context Protocol (MCP) tools](/en/mcp). When MCP servers
provide tools, they appear with a special naming pattern that you can match in
your hooks.

### MCP Tool Naming

MCP tools follow the pattern `mcp__<server>__<tool>`, for example:

* `mcp__memory__create_entities` - Memory server's create entities tool
* `mcp__filesystem__read_file` - Filesystem server's read file tool
* `mcp__github__search_repositories` - GitHub server's search tool

### Configuring Hooks for MCP Tools

You can target specific MCP tools or entire MCP servers:

```json  theme={null}
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__memory__.*",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Memory operation initiated' >> ~/mcp-operations.log"
          }
        ]
      },
      {
        "matcher": "mcp__.*__write.*",
        "hooks": [
          {
            "type": "command",
            "command": "/home/user/scripts/validate-mcp-write.py"
          }
        ]
      }
    ]
  }
}
```

## Examples

<Tip>
  For practical examples including code formatting, notifications, and file protection, see [More Examples](/en/hooks-guide#more-examples) in the get started guide.
</Tip>

## Security Considerations

### Disclaimer

**USE AT YOUR OWN RISK**: Claude Code hooks execute arbitrary shell commands on
your system automatically. By using hooks, you acknowledge that:

* You are solely responsible for the commands you configure
* Hooks can modify, delete, or access any files your user account can access
* Malicious or poorly written hooks can cause data loss or system damage
* Anthropic provides no warranty and assumes no liability for any damages
  resulting from hook usage
* You should thoroughly test hooks in a safe environment before production use

Always review and understand any hook commands before adding them to your
configuration.

### Security Best Practices

Here are some key practices for writing more secure hooks:

1. **Validate and sanitize inputs** - Never trust input data blindly
2. **Always quote shell variables** - Use `"$VAR"` not `$VAR`
3. **Block path traversal** - Check for `..` in file paths
4. **Use absolute paths** - Specify full paths for scripts (use
   "\$CLAUDE\_PROJECT\_DIR" for the project path)
5. **Skip sensitive files** - Avoid `.env`, `.git/`, keys, etc.

### Configuration Safety

Direct edits to hooks in settings files don't take effect immediately. Claude
Code:

1. Captures a snapshot of hooks at startup
2. Uses this snapshot throughout the session
3. Warns if hooks are modified externally
4. Requires review in `/hooks` menu for changes to apply

This prevents malicious hook modifications from affecting your current session.

## Hook Execution Details

* **Timeout**: 60-second execution limit by default, configurable per command.
  * A timeout for an individual command does not affect the other commands.
* **Parallelization**: All matching hooks run in parallel
* **Deduplication**: Multiple identical hook commands are deduplicated automatically
* **Environment**: Runs in current directory with Claude Code's environment
  * The `CLAUDE_PROJECT_DIR` environment variable is available and contains the
    absolute path to the project root directory (where Claude Code was started)
  * The `CLAUDE_CODE_REMOTE` environment variable indicates whether the hook is running in a remote (web) environment (`"true"`) or local CLI environment (not set or empty). Use this to run different logic based on execution context.
* **Input**: JSON via stdin
* **Output**:
  * PreToolUse/PostToolUse/Stop/SubagentStop: Progress shown in transcript (Ctrl-R)
  * Notification/SessionEnd: Logged to debug only (`--debug`)
  * UserPromptSubmit/SessionStart: stdout added as context for Claude

## Debugging

### Basic Troubleshooting

If your hooks aren't working:

1. **Check configuration** - Run `/hooks` to see if your hook is registered
2. **Verify syntax** - Ensure your JSON settings are valid
3. **Test commands** - Run hook commands manually first
4. **Check permissions** - Make sure scripts are executable
5. **Review logs** - Use `claude --debug` to see hook execution details

Common issues:

* **Quotes not escaped** - Use `\"` inside JSON strings
* **Wrong matcher** - Check tool names match exactly (case-sensitive)
* **Command not found** - Use full paths for scripts

### Advanced Debugging

For complex hook issues:

1. **Inspect hook execution** - Use `claude --debug` to see detailed hook
   execution
2. **Validate JSON schemas** - Test hook input/output with external tools
3. **Check environment variables** - Verify Claude Code's environment is correct
4. **Test edge cases** - Try hooks with unusual file paths or inputs
5. **Monitor system resources** - Check for resource exhaustion during hook
   execution
6. **Use structured logging** - Implement logging in your hook scripts

### Debug Output Example

Use `claude --debug` to see hook execution details:

```
[DEBUG] Executing hooks for PostToolUse:Write
[DEBUG] Getting matching hook commands for PostToolUse with query: Write
[DEBUG] Found 1 hook matchers in settings
[DEBUG] Matched 1 hooks for query "Write"
[DEBUG] Found 1 hook commands to execute
[DEBUG] Executing hook command: <Your command> with timeout 60000ms
[DEBUG] Hook command completed with status 0: <Your stdout>
```

Progress messages appear in transcript mode (Ctrl-R) showing:

* Which hook is running
* Command being executed
* Success/failure status
* Output or error messages
