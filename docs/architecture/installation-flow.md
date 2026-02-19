# Installation & Hook Architecture

This document outlines the complete installation lifecycle and hook execution model for `claude-mem`.

## Architecture Overview

`claude-mem` uses a **singular built artifact** architecture. All system components (CLI, Worker Daemon, MCP Server, and Lifecycle Hooks) are bundled into a single platform-specific binary named `claude-mem`.

## Installation Flow Diagram

```mermaid
graph TD
    %% Entry Points
    Start[User Installation] --> Direct[npx claude-mem-installer]
    Start --> OpenClaw[curl install.cmem.ai/openclaw.sh]
    Start --> Marketplace[Claude Code Plugin Marketplace]

    %% Direct Installer Pipeline (installer/)
    subgraph "Direct Installer (installer/)"
        Direct --> DepCheck[Dependency Checks: Git, Bun, Node]
        DepCheck --> Config[Provider & IDE Configuration]
        Config --> Clone[Clone Repo to Temp Dir]
        Clone --> BuildHook[Run: npm run build]
        BuildHook --> SyncCache[Sync to ~/.claude/plugins/cache/]
        SyncCache --> EnablePlugin[Update ~/.claude/settings.json]
    end

    %% Build System (scripts/build-hooks.js)
    subgraph "Build Pipeline (Bun Compile)"
        BuildHook --> ESB_Bin[bun build --compile src/cli/cli.ts → claude-mem]
    end

    %% Hook Infrastructure (plugin/hooks/)
    subgraph "Runtime Hook Layer"
        EnablePlugin --> SessionStart[Claude Session Starts]
        SessionStart --> HooksJson{hooks.json}
        HooksJson --> SetupScript[scripts/setup.sh]
        HooksJson --> CLI_Hook[scripts/claude-mem hook event]
        
        SetupScript --> DataDir[Create ~/.claude-mem/]
        SetupScript --> PathSetup[Symlink ~/.local/bin/claude-mem]
        
        CLI_Hook --> DaemonCheck{Worker Running?}
        DaemonCheck -- No --> Spawn[Spawn: claude-mem daemon]
        DaemonCheck -- Yes --> SendEvent[Send Hook Event to Worker]
    end

    %% OpenClaw Path (openclaw/)
    subgraph "OpenClaw System"
        OpenClaw --> OC_Plugin[Build & Register OpenClaw Plugin]
        OC_Plugin --> OC_Config[Set Memory Slot to 'claude-mem']
        OC_Config --> OC_Worker[Start Background Worker]
    end

    %% Output
    Spawn --> Running[Worker Daemon Active]
    OC_Worker --> Running
    SendEvent --> PersistentMemory[Observations Compressed & Stored]

    %% Styling
    style Direct fill:#f9f,stroke:#333,stroke-width:2px
    style OpenClaw fill:#bbf,stroke:#333,stroke-width:2px
    style Running fill:#dfd,stroke:#333,stroke-width:4px
```

## System Components (Unified Binary)

The `claude-mem` binary is a multi-call executable that behaves differently based on its arguments:

- **`claude-mem hook <event>`**: Executes a lifecycle hook (invoked by Claude Code).
- **`claude-mem daemon`**: Runs as the background worker service (orchestrator).
- **`claude-mem mcp`**: Runs as the Model Context Protocol search server.
- **`claude-mem statusline`**: Returns project metrics for shell status lines.
- **`claude-mem start/stop/status`**: Management commands for the daemon.

### Benefits of the Singular Artifact:
1.  **Fast Startup:** No Node.js/Bun cold start for hooks (native binary execution).
2.  **No Fallbacks:** Eliminated "intermediate" JS bundles and shell wrappers.
3.  **Atomic Updates:** Replacing a single binary updates the entire system.
4.  **Consistency:** The same code path is used for CLI and Daemon, reducing "works only in CLI" bugs.

## Setup Hook (`scripts/setup.sh`)
Executes on `SessionStart` to ensure the local environment is ready:
- Initializes `~/.claude-mem/` data directory.
- Manages `PATH` entries and symlinks in `~/.local/bin/`.
- Cleans up legacy configurations from shell profiles.
