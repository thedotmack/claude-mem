# 🪟 Windows folks — we think we fixed the big one. Help us test?

## 🐛 What was broken

- 🧟 **Leftover programs.** claude-mem starts a little search helper in the background. When it shut down, Windows only stopped the *top* program — the helpers underneath kept running like zombies.
- 🔒 **Stuck port.** Those zombies held onto the door claude-mem needs to start up again. So it couldn't restart. So every prompt got blocked. One person hit this **834 times in a single session.**
- 💾 **Disk eaten alive.** The zombies also left junk files behind, forever. One user measured **144 GB** of it. 😳
- 🤫 **Search quietly dying.** The helper could grab the *wrong* Python off your machine and just... stop working. No error. No warning. Memory search silently stopped.

## 🔧 What we fixed

- 👨‍👩‍👧‍👦 Shutdown now closes the **whole family** of programs, not just the parent.
- 🧹 Stopped killing things mid-download, so junk files stop piling up.
- 🐍 The wrong Python can't sneak in anymore.
- 🎯 Made sure we never shut down the wrong program by accident (this one took **7 rounds** of review to get right 😅).
- 🤖 **Added real Windows tests.** Our tests used to never actually start the search helper on Windows — which is exactly why these bugs kept slipping through. Now they do, on every change.

## ✅ Actually proven on Windows

Not "should work" — these ran on a real Windows machine and passed:

- ✅ Search helper starts, saves a memory, finds it again
- ✅ Shutdown leaves **zero** leftover programs
- ✅ Still works even with a messy Python setup

---

## 📦 Want to try it? (~10 min)

**You'll need:** Node.js and Git. ☕ Grab a coffee, the build takes a few minutes.

Open **PowerShell** and paste these **one at a time**:

```powershell
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
git checkout windows-megafix
npm install
npm run build-and-sync
node dist\npx-cli\index.js doctor
```

(That's every Windows fix rolled into one branch — PR **#3661**.)

That last one prints a health check. 🩺

## 👀 What "it worked" looks like

- ✅ `doctor` shows green/OK lines — especially **Bun**, **uv**, and **Worker daemon**
- ✅ Claude Code starts normally, no blocked prompts
- ✅ Memory search actually returns results
- ✅ Stop claude-mem, then run `Get-Process uv,python -ErrorAction SilentlyContinue` — you should see **nothing left over**. That's the whole fix in one command. 🎉

## 🆘 If something breaks

Drop us a comment with:

1. 📋 The full output of `node dist\npx-cli\index.js doctor`
2. 🪟 Your Windows version
3. 📜 Your latest log file from `%USERPROFILE%\.claude-mem\logs\`

Genuinely — a broken report is **just as useful** as a working one. That's the point of testing. 🙏

## ⏪ Want out? Easy.

```powershell
npx claude-mem@latest install
```

Puts you straight back on the normal released version. Nothing to undo, nothing to clean up. 👍

---

### 📚 The pull requests, if you're curious

- **#3661** — the rollup branch you just installed (`windows-megafix`), all of the below combined

- **#3644** — the big one (leftover programs, stuck port, disk junk, silent search death)
- **#3647** — code search silently returning nothing on Windows
- **#3648** — data getting saved to the wrong folder if you used `~\` in your settings
- **#3649** — you now get a *clear message* if Git Bash is missing, instead of a cryptic crash
- **#3657** — fixes building from source on Windows (it needed a Mac/Linux-only tool before 🙃)

⚠️ These aren't merged yet — you'd be testing a preview. That's exactly what we need right now. 💛
