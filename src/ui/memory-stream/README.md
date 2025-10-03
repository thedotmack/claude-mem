# Memory Stream - Live Memory Viewer

A real-time slideshow viewer for claude-mem memories with SSE (Server-Sent Events) support.

## Features

- 📡 **Live streaming** - Automatically displays new memories as they're created
- 🎬 **Auto-slideshow** - Cycles through memories every 5 seconds
- ⏸️ **Pause/Resume** - Space bar or button controls
- ⌨️ **Keyboard navigation** - Arrow keys to navigate
- 🎨 **Beautiful UI** - Cyberpunk-themed neural network aesthetic

## Setup

### 1. Start the SSE server

```bash
node src/ui/memory-stream/server.js
# or use the package script:
npm run memory-stream:server
```

This will:
- Watch `~/.claude-mem/claude-mem.db-wal` for changes
- Serve SSE events on `http://localhost:3001/stream`
- Automatically detect and broadcast new memories

### 2. Start your React dev server

```bash
# In your React app directory
npm run dev
# or
bun dev
```

### 3. Open the viewer

Navigate to your React app (usually `http://localhost:5173`)

## Usage

### Live Mode (Recommended)

1. Click **"CONNECT LIVE STREAM"**
2. Server must be running (`node memory-stream-server.js`)
3. New memories appear automatically as they're created
4. Perfect for real-time monitoring during Claude Code sessions

### Presentation Mode (Alternative)

1. Click **"START PRESENTATION"**
2. Select your `~/.claude-mem/claude-mem.db` file
3. Static slideshow of existing memories
4. No server required

## Controls

- **Space** - Pause/Resume slideshow
- **←** - Previous memory
- **→** - Next memory
- **Click buttons** - Same as keyboard controls

## How It Works

### SSE Server
- Uses `better-sqlite3` with WAL mode (already enabled in claude-mem)
- Watches the `-wal` file for changes using `fs.watch()`
- Queries for new memories when WAL changes detected
- Broadcasts to all connected clients via Server-Sent Events

### React Client
- Connects to SSE endpoint via `EventSource`
- Auto-reconnects on connection loss
- Appends new memories to the slideshow in real-time
- No polling, pure event-driven updates

## Technical Details

**Database**: SQLite with WAL (Write-Ahead Logging) mode
**Change Detection**: `fs.watch()` on `claude-mem.db-wal`
**Transport**: Server-Sent Events (SSE)
**Auto-reconnect**: 2-second retry on connection loss
**CORS**: Enabled for local development

## Troubleshooting

**"Connection lost"**
- Ensure server is running: `node src/ui/memory-stream/server.js`
- Check port 3001 is available
- Look for server console output

**No memories showing**
- Verify memories exist with `title` field
- Check database path: `~/.claude-mem/claude-mem.db`
- Try "START PRESENTATION" mode to verify database access

**WAL file not found**
- WAL mode auto-enabled by claude-mem
- File created automatically on first write
- Check database exists at expected path
