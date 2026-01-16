# OpenCode Integration Guide

This guide explains how to integrate claude-mem with OpenCode, enabling persistent memory across your OpenCode sessions.

## Overview

OpenCode is an AI coding agent that supports the Model Context Protocol (MCP) as a client. Claude-mem provides an MCP server that gives OpenCode access to searchable memory across sessions.

## Setup Options

### Option 1: Local Setup (Same Machine)

If OpenCode and claude-mem are running on the same machine:

1. **Start the claude-mem worker:**
   ```bash
   npm run worker:start
   ```

2. **Configure OpenCode to use the built-in MCP server:**

   Add to your OpenCode config file (`~/.opencode/config.json` or similar):
   ```json
   {
     "mcp": {
       "claude-mem": {
         "command": "node",
         "args": ["/path/to/claude-mem/plugin/scripts/mcp-server.cjs"]
       }
     }
   }
   ```

### Option 2: Remote Setup (Different Machines)

If OpenCode runs on a different machine than claude-mem (common in multi-agent deployments):

1. **On the machine running claude-mem:**

   Start the worker in network mode:
   ```bash
   export CLAUDE_MEM_WORKER_BIND=0.0.0.0  # Listen on all interfaces
   export CLAUDE_MEM_WORKER_PORT=37777
   npm run worker:start
   ```

2. **On the machine running OpenCode:**

   Add to your OpenCode config:
   ```json
   {
     "mcp": {
       "claude-mem-remote": {
         "command": "node",
         "args": ["/path/to/remote-mcp-wrapper.js"],
         "env": {
           "CLAUDE_MEM_REMOTE_HOST": "192.168.1.100",
           "CLAUDE_MEM_REMOTE_PORT": "37777"
         }
       }
     }
   }
   ```

   Replace `192.168.1.100` with the actual IP address of your claude-mem server.

## Environment Variables

### Worker Service (Server Side)

- `CLAUDE_MEM_WORKER_BIND` - IP address to bind to (default: `127.0.0.1`)
  - Use `127.0.0.1` for local-only access
  - Use `0.0.0.0` to accept connections from other machines
  - Use specific IP for network interface binding

- `CLAUDE_MEM_WORKER_PORT` - Port to listen on (default: `37777`)

- `CLAUDE_MEM_WORKER_HOST` - Hostname for client connections (default: `localhost`)
  - This is the hostname clients will use to connect
  - For remote access, set this to your machine's IP or hostname

### Remote MCP Wrapper (Client Side)

- `CLAUDE_MEM_REMOTE_HOST` - Host where claude-mem worker is running (default: `localhost`)
- `CLAUDE_MEM_REMOTE_PORT` - Port where claude-mem worker is running (default: `37777`)

## Network Mode Architecture

When deploying claude-mem for multi-agent access:

```
┌─────────────────┐         ┌─────────────────┐
│  OpenCode #1    │         │  OpenCode #2    │
│  (Machine A)    │         │  (Machine B)    │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │ MCP Protocol              │ MCP Protocol
         │ (stdio)                   │ (stdio)
         │                           │
         ▼                           ▼
┌─────────────────┐         ┌─────────────────┐
│ remote-mcp-     │         │ remote-mcp-     │
│ wrapper.js      │         │ wrapper.js      │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │ HTTP                      │ HTTP
         │                           │
         └────────┬──────────────────┘
                  │
                  ▼
         ┌────────────────┐
         │  Claude-Mem    │
         │  Worker Service│
         │  (Machine C)   │
         │  Port 37777    │
         └────────────────┘
```

## Available MCP Tools

Once configured, OpenCode will have access to these claude-mem tools:

1. **`search(query, ...)`** - Search memory and get an index with observation IDs
2. **`timeline(anchor, ...)`** - Get chronological context around an observation
3. **`get_observations(ids)`** - Fetch full details for specific observations

### Recommended 3-Layer Workflow

For optimal token efficiency (10x savings):

```javascript
// 1. Search for relevant topics
search({ query: "authentication implementation" })

// 2. Get context around interesting results
timeline({ anchor: 1234, depth_before: 2, depth_after: 2 })

// 3. Fetch full details only for filtered IDs
get_observations({ ids: [1234, 1235, 1236] })
```

## Verification

1. **Check worker is running:**
   ```bash
   curl http://localhost:37777/api/health
   ```

2. **Test from OpenCode:**
   In an OpenCode session, try:
   ```
   Search my memory for "recent work"
   ```

   OpenCode should automatically use the `search` tool from claude-mem.

## Firewall Configuration

If using network mode, ensure port 37777 is accessible:

```bash
# Linux (ufw)
sudo ufw allow 37777/tcp

# macOS (temporary)
# Firewall settings in System Preferences

# Check if port is listening
netstat -an | grep 37777
```

## Security Notes

- The worker service currently has **no authentication**
- Only expose on trusted networks
- Consider using SSH tunneling for remote access:
  ```bash
  ssh -L 37777:localhost:37777 user@remote-machine
  ```

## Troubleshooting

### "Cannot connect to claude-mem worker"

1. Verify worker is running: `ps aux | grep worker-service`
2. Check worker logs: `~/.claude-mem/logs/`
3. Test connectivity: `curl http://localhost:37777/api/health`

### "MCP server not found"

1. Verify path to `mcp-server.cjs` or `remote-mcp-wrapper.js`
2. Check OpenCode config syntax
3. Restart OpenCode after config changes

### "ECONNREFUSED" in remote setup

1. Verify `CLAUDE_MEM_WORKER_BIND=0.0.0.0` is set
2. Check firewall rules allow port 37777
3. Verify correct IP address in `CLAUDE_MEM_REMOTE_HOST`
4. Test with `telnet <host> 37777`

## Next Steps

- See `CLAUDE.md` for full claude-mem documentation
- Visit https://docs.claude-mem.ai for online docs
- Check https://opencode.ai for OpenCode documentation
