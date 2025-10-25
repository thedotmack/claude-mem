---
description: Manage claude-mem plugin settings using natural language
tags: [settings, configuration, claude-mem]
skillType: project
---

# Claude-Mem Settings Management

This skill enables natural language management of claude-mem plugin settings.

## When to Use This Skill

Activate this skill when the user wants to:
- View current claude-mem settings
- Change any claude-mem configuration (model, ports, toggles, depth)
- Enable or disable memory features
- Reset settings to defaults
- Get help with configuration options

## Available Settings

### 1. model
AI model used for processing observations and generating summaries.

**Options:**
- `claude-haiku-4-5` - Fast, cost-efficient
- `claude-sonnet-4-5` - Balanced (default)
- `claude-opus-4` - Most capable
- `claude-3-7-sonnet` - Alternative version

**User phrases:**
- "change my model to haiku"
- "use opus for claude-mem"
- "switch to sonnet"

### 2. workerPort
Port number for the background worker service HTTP API.

**Range:** 1-65535 (default: 37777)

**User phrases:**
- "change worker port to 38000"
- "use port 8080 for the worker"

### 3. enableMemoryStorage
Controls whether tool observations are saved to the database.

**Options:** true (default), false

**User phrases:**
- "turn off memory storage"
- "disable saving observations"
- "enable memory storage"
- "start saving tool usage again"

### 4. enableContextInjection
Controls whether context from previous sessions is injected at session start.

**Options:** true (default), false

**User phrases:**
- "disable context injection"
- "turn off context loading"
- "enable context injection"
- "show me previous session context"

### 5. contextDepth
Number of recent sessions to load when injecting context.

**Range:** 1-50 (default: 5)
**Note:** Higher values = more historical context but more tokens used

**User phrases:**
- "set context depth to 10"
- "load last 3 sessions"
- "increase context depth to 20"

## Quick Slash Commands

For common toggle operations, users can use these slash commands:

- `/claude-mem:context-on` - Enable context injection
- `/claude-mem:context-off` - Disable context injection
- `/claude-mem:memory-on` - Enable memory storage
- `/claude-mem:memory-off` - Disable memory storage

The plugin prefix `/claude-mem:` is optional unless there are name collisions.

## How to Use Settings CLI

The settings CLI is located at: `${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js`

**IMPORTANT:** Always use the `${CLAUDE_PLUGIN_ROOT}` environment variable to reference the plugin path. This environment variable is automatically provided by Claude Code and points to the plugin's installation directory. Always wrap it in double quotes to handle spaces in paths.

### Commands

```bash
# View current settings (formatted with descriptions)
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js"

# View current settings (JSON format)
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --json

# Get specific setting value
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --get <key>

# Set specific setting
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set <key>=<value>

# Reset to defaults
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --reset

# Show help
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --help
```

## Instructions for Claude

When the user asks to view or modify claude-mem settings:

1. **Parse the user's intent:**
   - Identify which setting(s) they want to view or modify
   - Extract the desired value if they're making a change
   - Map natural language to exact setting keys

**Quick command recommendation:**
- For simple toggles (enable/disable context or memory), recommend the slash commands
- For viewing settings, changing model, port, or depth, use the CLI
- If the user prefers CLI, always honor that preference

2. **For viewing settings:**
   ```bash
   # Show all settings
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js"

   # Show specific setting (JSON output)
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --get <key>
   ```

3. **For changing settings:**
   ```bash
   # Set a specific value
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set <key>=<value>
   ```

   **Mapping examples:**
   - "change to haiku" → `--set model=claude-haiku-4-5`
   - "disable memory" → `--set enableMemoryStorage=false`
   - "set depth to 10" → `--set contextDepth=10`
   - "turn off context" → `--set enableContextInjection=false`

4. **After making changes:**
   - Confirm the change was successful
   - Explain what the setting does if the user seems unsure
   - **IMPORTANT:** If the setting changed was `model` or `workerPort`, automatically restart the worker service:
     ```bash
     pm2 restart claude-mem-worker
     ```
   - For `enableMemoryStorage`, `enableContextInjection`, or `contextDepth` changes, no restart is needed (changes take effect immediately)

5. **For reset requests:**
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --reset
   ```

## Important Notes

- **Settings file location:** `~/.claude-mem/settings.json`
- **Worker restart:** Changes to `model` or `workerPort` REQUIRE restarting the worker service. Claude should automatically run `pm2 restart claude-mem-worker` after changing these settings.
- **No restart needed:** Changes to `enableMemoryStorage`, `enableContextInjection`, or `contextDepth` take effect immediately on the next hook execution.

## Example Interactions

### Example 1: View Settings
**User:** "Show me my claude-mem settings"

**Claude response:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js"
```

Then explain the current configuration to the user in plain language.

### Example 2: Change Model
**User:** "Change my model to haiku to save money"

**Claude response:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set model=claude-haiku-4-5
pm2 restart claude-mem-worker
```

Confirm: "I've changed your model to claude-haiku-4-5 (Haiku). This is the most cost-efficient option and will process your observations faster. I've also restarted the worker service so the change takes effect immediately."

### Example 3: Disable Memory (Using Slash Command)
**User:** "Turn off claude-mem for now, I don't want it saving anything"

**Claude response:**
You can use the quick slash command:
```
/claude-mem:memory-off
```

Or if you prefer the CLI:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set enableMemoryStorage=false
```

Confirm: "Memory storage has been disabled. Claude-mem will no longer save tool observations to the database. Context injection is still active, so you'll still see previous session summaries. To re-enable, use `/claude-mem:memory-on`."

### Example 4: Increase Context Depth
**User:** "I want to see more history, set context depth to 10"

**Claude response:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set contextDepth=10
```

Confirm: "I've increased your context depth to 10 sessions. You'll now see observations from the last 10 sessions at session start. Note that this will use more tokens in your context window."

### Example 5: Multiple Changes
**User:** "Use haiku and increase context depth to 8"

**Claude response:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set model=claude-haiku-4-5
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --set contextDepth=8
```

Confirm both changes and their implications.

## Error Handling

If the CLI returns an error:
- Parse the error message
- Explain what went wrong in plain language
- Suggest the correct format or valid options
- Show the user how to fix it

## Getting Help

Direct users to run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/settings-cli.js" --help
```

This shows comprehensive help with all options and examples.
