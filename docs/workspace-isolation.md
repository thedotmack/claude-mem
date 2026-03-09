# Workspace Isolation

Workspace isolation allows you to keep memory data completely separate between different clients, organizations, or project groups. This is essential for:

- **Consultants/Freelancers** working with multiple clients
- **Agencies** managing multiple client projects
- **Organizations** with strict data separation requirements
- **Developers** wanting to separate work and personal projects

## How It Works

When workspace isolation is enabled, claude-mem creates separate SQLite databases for each configured workspace. Projects within the same workspace share memory (which is desirable for related projects), while projects in different workspaces are completely isolated.

```
~/.claude-mem/
├── workspaces/
│   ├── client_a/
│   │   ├── claude-mem.db      # Client A's memory
│   │   ├── vector-db/         # Client A's vectors
│   │   └── settings.json      # Client A's settings
│   └── client_b/
│       ├── claude-mem.db      # Client B's memory
│       ├── vector-db/         # Client B's vectors
│       └── settings.json      # Client B's settings
├── claude-mem.db              # Global database (fallback)
└── settings.json              # Global settings
```

## Configuration

### Option 1: Environment Variable

Set `CLAUDE_MEM_WORKSPACE_ROOTS` with comma-separated paths to your workspace root directories:

```bash
export CLAUDE_MEM_WORKSPACE_ROOTS="/path/to/ClientA,/path/to/ClientB"
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) to make it permanent:

```bash
# ~/.zshrc or ~/.bashrc
export CLAUDE_MEM_WORKSPACE_ROOTS="$HOME/work/clients/ClientA,$HOME/work/clients/ClientB"
```

### Option 2: Settings File

Add to `~/.claude-mem/settings.json`:

```json
{
  "workspaceRoots": [
    "/path/to/ClientA",
    "/path/to/ClientB"
  ]
}
```

## Workspace Detection

claude-mem automatically detects which workspace you're in based on your current working directory:

| Working Directory | Detected Workspace | Database Used |
|-------------------|-------------------|---------------|
| `/path/to/ClientA/project1` | `client_a` | `~/.claude-mem/workspaces/client_a/claude-mem.db` |
| `/path/to/ClientA/project2` | `client_a` | `~/.claude-mem/workspaces/client_a/claude-mem.db` |
| `/path/to/ClientB/app` | `client_b` | `~/.claude-mem/workspaces/client_b/claude-mem.db` |
| `/home/user/personal/side-project` | `global` | `~/.claude-mem/claude-mem.db` |

### Key Behaviors

1. **Same Workspace = Shared Memory**: Projects in the same workspace (e.g., `ClientA/project1` and `ClientA/project2`) share the same database. This allows cross-project context within a client.

2. **Different Workspaces = Complete Isolation**: Projects in different workspaces (e.g., `ClientA/project1` and `ClientB/app`) have completely separate databases. No data leakage.

3. **Global Fallback**: Projects outside configured workspaces use the global database.

## Examples

### Consulting Setup

```bash
# Directory structure
~/clients/
├── acme-corp/           # Workspace: acme_corp
│   ├── backend-api/
│   ├── frontend-app/
│   └── mobile-app/
├── globex/              # Workspace: globex
│   ├── data-pipeline/
│   └── dashboard/
└── personal/            # Uses global database
    └── side-projects/

# Configuration
export CLAUDE_MEM_WORKSPACE_ROOTS="$HOME/clients/acme-corp,$HOME/clients/globex"
```

### Multi-Organization Setup

```bash
# Directory structure
~/work/
├── company-a/           # Workspace: company_a
│   └── projects/
├── company-b/           # Workspace: company_b
│   └── projects/
└── open-source/         # Uses global database
    └── contributions/

# Configuration
export CLAUDE_MEM_WORKSPACE_ROOTS="$HOME/work/company-a,$HOME/work/company-b"
```

## Workspace Name Sanitization

Workspace names are derived from the directory name and sanitized for filesystem compatibility:

| Directory Name | Workspace Name |
|---------------|----------------|
| `ClientA` | `clienta` |
| `Client A` | `client_a` |
| `My Client: ABC` | `my_client_abc` |
| `Project (2024)` | `project_2024_` |

## Verifying Isolation

You can verify workspace isolation is working by checking the logs:

```bash
# Look for workspace detection in Claude Code logs
# When working in a configured workspace:
[HOOK] session-init: Calling /api/sessions/init
  contentSessionId: abc123
  project: my-project
  workspace: client_a      # ← Workspace detected
  isolated: true           # ← Using isolated database

# When working outside configured workspaces:
[HOOK] session-init: Calling /api/sessions/init
  contentSessionId: xyz789
  project: side-project
  workspace: global        # ← Using global database
  isolated: false
```

## Backwards Compatibility

- **No configuration = No change**: If `CLAUDE_MEM_WORKSPACE_ROOTS` is not set, claude-mem behaves exactly as before with a single global database.
- **Existing data preserved**: Your existing `~/.claude-mem/claude-mem.db` continues to work as the global database.
- **No migration required**: Workspace isolation is additive; existing data is not affected.

## Limitations

1. **Workspace roots must be absolute paths**: Relative paths are resolved from the current directory, which may cause unexpected behavior.

2. **Nested workspaces not supported**: If `/path/to/A` and `/path/to/A/B` are both configured as workspace roots, behavior is undefined. Configure only the top-level directories.

3. **Session continuity**: If you switch workspaces mid-session (e.g., `cd` from ClientA to ClientB), the session continues in the original workspace until you start a new Claude Code session.

## Troubleshooting

### Workspace not detected

Check that:
1. The workspace root path is absolute
2. Your current directory is inside the workspace root
3. The environment variable is exported correctly

```bash
# Verify configuration
echo $CLAUDE_MEM_WORKSPACE_ROOTS

# Verify current directory is inside a workspace
pwd
# Should be a subdirectory of one of the workspace roots
```

### Wrong workspace detected

This can happen if:
1. Multiple workspace roots overlap
2. Symlinks are involved (workspace detection uses resolved paths)

### Data appears in wrong workspace

Check the logs for workspace detection messages. The workspace is determined at session start, not on each operation.

## Security Considerations

While workspace isolation provides data separation, it is not a security boundary:

- All databases are stored under `~/.claude-mem/` (or your configured data directory)
- A user with filesystem access can read any workspace's data
- For true security isolation, use separate user accounts or containers

Workspace isolation is designed to prevent **accidental** context leakage, not **malicious** access.
