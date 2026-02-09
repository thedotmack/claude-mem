---
name: Bug report
about: Use the automated bug report tool for best results
title: ''
labels: 'bug, needs-triage'
assignees: ''

---

## Before submitting

- [ ] I searched [existing issues](https://github.com/thedotmack/claude-mem/issues) and confirmed this is not a duplicate

---

## ⚡ Quick Bug Report (Recommended)

**Use the automated bug report generator** for comprehensive diagnostics:

```bash
# Navigate to the plugin directory
cd ~/.claude/plugins/marketplaces/thedotmack

# Run the bug report tool
npm run bug-report
```

**Plugin Paths:**
- **macOS/Linux**: `~/.claude/plugins/marketplaces/thedotmack`
- **Windows**: `%USERPROFILE%\.claude\plugins\marketplaces\thedotmack`

**Features:**
- 🌎 Auto-translates any language to English
- 📊 Collects all diagnostics automatically
- 🤖 AI-formatted professional issue
- 🔒 Privacy-safe (paths sanitized, `--no-logs` option)
- 🌐 Auto-opens GitHub with pre-filled issue

---

## 📝 Manual Bug Report

If you prefer to file manually or can't access the plugin directory:

### Bug Description
A clear description of what the bug is.

### Steps to Reproduce
1. Go to '...'
2. Click on '...'
3. See error

### Expected Behavior
What you expected to happen.

### Environment
- **Claude-mem version**:
- **Claude Code version**:
- **OS**:
- **Platform**:

### Logs
Worker logs are located at:
- **Path**: `~/.claude-mem/logs/worker-YYYY-MM-DD.log`
- **Example**: `~/.claude-mem/logs/worker-2025-12-14.log`

Please paste relevant log entries (last 50 lines or error messages):

```
[Paste logs here]
```

### Additional Context
Any other context about the problem.
