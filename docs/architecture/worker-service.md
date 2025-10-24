# Worker Service

The worker service is a long-running HTTP API built with Express.js and managed by PM2. It processes observations through the Claude Agent SDK separately from hook execution to prevent timeout issues.

## Overview

- **Technology**: Express.js HTTP server
- **Process Manager**: PM2
- **Port**: Fixed port 37777 (configurable via `CLAUDE_MEM_WORKER_PORT`)
- **Location**: `src/services/worker-service.ts`
- **Built Output**: `plugin/scripts/worker-service.cjs`
- **Model**: Configurable via `CLAUDE_MEM_MODEL` environment variable (default: claude-sonnet-4-5)

## REST API Endpoints

The worker service exposes 6 HTTP endpoints:

### 1. Health Check
```
GET /health
```

**Response**:
```json
{
  "status": "ok",
  "uptime": 12345,
  "port": 37777
}
```

### 2. Initialize Session
```
POST /sessions/:sessionDbId/init
```

**Request Body**:
```json
{
  "sdk_session_id": "abc-123",
  "project": "my-project"
}
```

**Response**:
```json
{
  "success": true,
  "session_id": "abc-123"
}
```

### 3. Add Observation
```
POST /sessions/:sessionDbId/observations
```

**Request Body**:
```json
{
  "tool_name": "Read",
  "tool_input": {...},
  "tool_result": "...",
  "correlation_id": "xyz-789"
}
```

**Response**:
```json
{
  "success": true,
  "observation_id": 123
}
```

### 4. Generate Summary
```
POST /sessions/:sessionDbId/summarize
```

**Request Body**:
```json
{
  "trigger": "stop"
}
```

**Response**:
```json
{
  "success": true,
  "summary_id": 456
}
```

### 5. Session Status
```
GET /sessions/:sessionDbId/status
```

**Response**:
```json
{
  "session_id": "abc-123",
  "status": "active",
  "observation_count": 42,
  "summary_count": 1
}
```

### 6. Delete Session
```
DELETE /sessions/:sessionDbId
```

**Response**:
```json
{
  "success": true
}
```

**Note**: As of v4.1.0, the cleanup hook no longer calls this endpoint. Sessions are marked complete instead of deleted to allow graceful worker shutdown.

## PM2 Management

### Configuration

The worker is configured via `ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [{
    name: 'claude-mem-worker',
    script: './plugin/scripts/worker-service.cjs',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      FORCE_COLOR: '1'
    }
  }]
};
```

### Commands

```bash
# Start worker (auto-starts on first session)
npm run worker:start

# Stop worker
npm run worker:stop

# Restart worker
npm run worker:restart

# View logs
npm run worker:logs

# Check status
npm run worker:status
```

### Auto-Start Behavior

As of v4.0.0, the worker service auto-starts when the SessionStart hook fires. Manual start is optional.

## Claude Agent SDK Integration

The worker service routes observations to the Claude Agent SDK for AI-powered processing:

### Processing Flow

1. **Observation Queue**: Observations accumulate in memory
2. **SDK Processing**: Observations sent to Claude via Agent SDK
3. **XML Parsing**: Responses parsed for structured data
4. **Database Storage**: Processed observations stored in SQLite

### SDK Components

- **Prompts** (`src/sdk/prompts.ts`): Builds XML-structured prompts
- **Parser** (`src/sdk/parser.ts`): Parses Claude's XML responses
- **Worker** (`src/sdk/worker.ts`): Main SDK agent loop

### Model Configuration

Set the AI model used for processing via environment variable:

```bash
export CLAUDE_MEM_MODEL=claude-sonnet-4-5
```

Available models:
- `claude-haiku-4-5` - Fast, cost-efficient
- `claude-sonnet-4-5` - Balanced (default)
- `claude-opus-4` - Most capable
- `claude-3-7-sonnet` - Alternative version

## Port Allocation

The worker uses a fixed port (37777 by default) for consistent communication:

- **Default**: Port 37777
- **Override**: Set `CLAUDE_MEM_WORKER_PORT` environment variable
- **Port File**: `${CLAUDE_PLUGIN_ROOT}/data/worker.port` tracks current port

If port 37777 is in use, the worker will fail to start. Set a custom port via environment variable.

## Data Storage

The worker service stores data in the plugin data directory:

```
${CLAUDE_PLUGIN_ROOT}/data/
├── claude-mem.db           # SQLite database
├── worker.port             # Current worker port file
└── logs/
    ├── worker-out.log      # Worker stdout logs
    └── worker-error.log    # Worker stderr logs
```

## Error Handling

The worker implements graceful degradation:

- **Database Errors**: Logged but don't crash the service
- **SDK Errors**: Retried with exponential backoff
- **Network Errors**: Logged and skipped
- **Invalid Input**: Validated and rejected with error response

## Performance

- **Async Processing**: Observations processed asynchronously
- **In-Memory Queue**: Fast observation accumulation
- **Batch Processing**: Multiple observations processed together
- **Connection Pooling**: SQLite connections reused

## Troubleshooting

See [Troubleshooting - Worker Issues](../troubleshooting.md#worker-service-issues) for common problems and solutions.
