# 🧠 Claude Memory System (claude-mem)

## Remember that one thing? Neither do we… but `claude-mem` does! 😵‍💫

Stop repeating yourself. `claude-mem` remembers what you and Claude Code figure out, so every new chat starts smarter than the last.

## ⚡️ 10‑Second Setup

```bash
npm install -g claude-mem && claude-mem install
```

That’s it. Restart Claude Code and you’re good. No config. No tedious setup or dependencies.

## ✨ What You Get

- Remembers key insights from your chats with Claude Code
- Starts new sessions with the right context
- Works quietly in the background
- One-command install and status check

## 🗑️ Smart Trash™ (Your Panic Button)

Delete something by accident? It’s not gone.
- Everything goes to `~/.claude-mem/trash/`
- Restore with a single command: `claude-mem restore`
- Timestamped so you can see when things moved

## 🎯 Why It’s Useful

- No more re-explaining your project over and over
- Pick up exactly where you left off
- Find past solutions fast when you face a familiar bug
- Your knowledge compounds the more you use it

## 🧭 Minimal Commands You’ll Ever Need

```bash
claude-mem install          # Set up/repair integration
claude-mem status           # Check everything’s working
claude-mem load-context     # Peek at what it remembers
claude-mem logs             # If you’re curious
claude-mem uninstall        # Remove hooks

# Extras
claude-mem trash-view       # See what’s in Smart Trash™
claude-mem restore          # Restore deleted items
```

## 📁 Where Stuff Lives (super simple)

```
~/.claude-mem/
├── index/      # memory index
├── archives/   # transcripts
├── hooks/      # integration bits
├── trash/      # Smart Trash™
└── logs/       # diagnostics
```

## ✅ Requirements

- Node.js 18+
- Claude Code

## 🆘 If Something’s Weird

```bash
claude-mem status           # quick health check
claude-mem install --force  # fixes most issues
```

## 📄 License

Licensed under AGPL-3.0. See `LICENSE`.

---

## Ready to remember more and repeat less?

```bash
npm install -g claude-mem
claude-mem install
```

Your future self will thank you. 🧠✨