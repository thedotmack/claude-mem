# Claude-Mem Installation for OpenCode

This guide will install claude-mem with full lifecycle integration for OpenCode.

## Installation Steps

1. **Clone the repository**
   ```bash
   git clone https://github.com/thedotmack/claude-mem.git ~/.config/opencode/claude-mem
   ```

2. **Navigate to the directory**
   ```bash
   cd ~/.config/opencode/claude-mem
   ```

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Build the project**
   ```bash
   npm run build-and-sync
   ```

5. **Create plugin directory**
   ```bash
   mkdir -p ~/.config/opencode/plugin
   ```

6. **Link the plugin**
   ```bash
   ln -sf ~/.config/opencode/claude-mem/plugin/opencode/claude-mem.js ~/.config/opencode/plugin/claude-mem.js
   ```

7. **Start the worker service in background**
   ```bash
   cd ~/.config/opencode/claude-mem && nohup npm run worker:start > ~/.claude-mem/worker.log 2>&1 &
   ```

8. **Verify worker is running**
   ```bash
   sleep 2 && curl -s http://localhost:37777/api/health
   ```
   You should see: `{"status":"ok"}`

9. **Installation complete!**

   Restart OpenCode to activate the plugin.

   The plugin provides:
   - ✅ Automatic session tracking
   - ✅ Tool usage capture
   - ✅ File edit tracking
   - ✅ Context auto-injection
   - ✅ Memory search tools: `search_memory`, `timeline_memory`, `get_memory_details`

## Verification

After restarting OpenCode, check the plugin loaded:

```bash
# In your terminal (not OpenCode)
tail -f ~/.claude-mem/worker.log
```

You should see worker startup logs.

## Using Your Fork

If you prefer to use the fork with network mode and additional features:

Replace step 1 with:
```bash
git clone https://github.com/nycterent/claude-mem.git ~/.config/opencode/claude-mem
```

Then continue with steps 2-9.

## Already Have Claude-Mem?

If claude-mem is already installed elsewhere:

1. **Link the plugin**
   ```bash
   mkdir -p ~/.config/opencode/plugin
   ln -sf /path/to/your/claude-mem/plugin/opencode/claude-mem.js ~/.config/opencode/plugin/claude-mem.js
   ```

2. **Ensure worker is running**
   ```bash
   cd /path/to/your/claude-mem
   npm run worker:start &
   ```

3. **Restart OpenCode**

## Troubleshooting

### Worker not starting

Check logs:
```bash
tail -50 ~/.claude-mem/worker.log
```

### Port 37777 already in use

Kill existing worker:
```bash
pkill -f worker-service
```

Then restart:
```bash
cd ~/.config/opencode/claude-mem && npm run worker:start &
```

### Plugin not loading

Check symlink:
```bash
ls -l ~/.config/opencode/plugin/claude-mem.js
```

Should point to: `~/.config/opencode/claude-mem/plugin/opencode/claude-mem.js`

## Documentation

- **Full guide**: See `docs/OPENCODE.md` in the repository
- **Quick reference**: See `plugin/opencode/README.md`
- **Online docs**: https://docs.claude-mem.ai

## Next Steps

Once installed, try these commands in OpenCode:

```javascript
// Search past work
await tools.search_memory({ query: "authentication" })

// Get timeline around an observation
await tools.timeline_memory({ anchor: 1234 })

// Fetch full details
await tools.get_memory_details({ ids: [1234, 1235] })
```

The plugin will also automatically capture your sessions and inject relevant context!
