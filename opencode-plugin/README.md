# Claude-Mem for OpenCode

This is a port of the [Claude-Mem](https://github.com/thedotmack/claude-mem) memory system for [OpenCode](https://opencode.ai).

It enables OpenCode to:
1.  **Automatically capture** your work (commands, file edits, etc.) and store it in a persistent memory database.
2.  **Recall context** from previous sessions to give you better answers without needing to re-explain things.
3.  **Search memory** using the `mem-search` tool.

## Installation

### Prerequisites

1.  **Claude-Mem Worker Service**: You must have the main `claude-mem` worker service running. This plugin acts as a client to that service.
    *   If you have `claude-mem` installed for Claude Code, the worker is likely already installed.
    *   Start it with: `npm run worker:start` (from the claude-mem repo) or ensure it's running on port 37777.

2.  **Install the Plugin**:

    You can install this plugin globally or per-project.

    **Global Installation:**
    ```bash
    mkdir -p ~/.config/opencode/plugin
    ln -s $(pwd)/opencode-plugin/dist/index.js ~/.config/opencode/plugin/claude-mem.js
    ```
    *(Note: You need to build the plugin first using `cd opencode-plugin && npm install && npm run build`)*

    **Per-Project Installation:**
    Copy or symlink the built `index.js` to your project's `.opencode/plugin/` directory.

## Usage

Once installed, simply start using OpenCode.

*   **Automatic Context**: When you start a session, you should see a system message indicating "Memory Active".
*   **Search**: You can ask OpenCode to "search memory for X" or "what did we do last time?", and it will use the `mem-search` tool.
*   **Web Viewer**: Visit `http://localhost:37777` to see your memory stream in real-time.

## Development

1.  Navigate to `opencode-plugin`.
2.  Run `bun install`.
3.  Run `bun test` to run tests.
4.  Run `bun run build` to compile to JavaScript.

## Architecture

This plugin hooks into OpenCode lifecycle events:
*   `session.created`: Initializes a session in the worker and injects recent context.
*   `tool.execute.after`: Sends tool inputs/outputs to the worker for observation.
*   `session.idle`: Triggers session summarization in the worker.
