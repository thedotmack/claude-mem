# Getting Claude-Mem Working for Synth Development

A complete, plain-language guide to installing and using claude-mem in your synthesizer design and audio programming workflow.

---

## What Is Claude-Mem?

Claude-mem gives Claude Code **persistent memory across sessions**.

Without it: every time you start a new Claude Code session, Claude starts completely fresh. It has no idea what you worked on yesterday, which filter you implemented last week, or why you made that signal routing decision.

With it: at the start of every session, Claude automatically sees a summary of your recent work. It knows you implemented a Moog ladder filter, that you fixed an aliasing issue with 4x oversampling, and what sound patches you designed. This context is built automatically in the background — you just code normally.

---

## Prerequisites

Before installing, make sure you have:

- **Claude Code** installed and working in your terminal (`claude` command)
- **Node.js** v18 or newer (`node --version`)
- **An Anthropic API key** set up (claude-mem uses it to process observations)

That's it. Bun and uv (Python) are automatically installed by claude-mem on first run.

---

## Part 1: Installation

### Step 1: Open a Claude Code Session

In your terminal:

```bash
claude
```

This opens an interactive Claude Code session.

### Step 2: Install the Plugin

Type these two commands inside the Claude Code session (one at a time, press Enter after each):

```
/plugin marketplace add thedotmack/claude-mem
```

Wait for it to complete, then:

```
/plugin install claude-mem
```

### Step 3: Restart Claude Code

Type `/exit` or press `Ctrl+C` to close the session, then open a new one:

```bash
claude
```

**On first restart**, claude-mem will automatically:
- Install its dependencies (takes 2-5 seconds the first time)
- Start its background worker service on port 37777
- Create its database at `~/.claude-mem/claude-mem.db`
- Create a default settings file at `~/.claude-mem/settings.json`

You'll see a brief message about memory context. That means it's working.

---

## Part 2: Enable Synth-Dev Mode

By default, claude-mem uses its standard `code` mode which captures general programming work. The `synth-dev` mode captures audio-specific observations: DSP algorithms, sound designs, parameter ranges, CPU optimizations, and audio bug fixes.

### Option A: Per-Project (Recommended)

Add this to the `CLAUDE.md` file in your synth project's root directory. Create one if it doesn't exist:

```markdown
## Claude-Mem Mode

Use synth-dev mode for this project. This is synthesizer/audio DSP development work.
```

Claude will read this at the start of each session and tell claude-mem to use the right mode for that project.

### Option B: Global Default

If all your work is synth-related, set it globally by editing `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_MODE": "synth-dev"
}
```

The file is at `~/.claude-mem/settings.json`. Open it in any text editor and add or change that line.

---

## Part 3: Verify It's Working

### Check the Worker Is Running

Open your browser and go to:

```
http://localhost:37777
```

If you see the claude-mem web viewer (a timeline interface), the worker is running. If you get "connection refused", the worker isn't running yet — start a new Claude Code session to trigger it.

### Check the API Is Responding

In a separate terminal:

```bash
curl http://localhost:37777/api/health
```

You should get a JSON response like `{"status":"ok","version":"9.x.x"}`.

### Watch Memory Being Captured in Real Time

1. Open `http://localhost:37777` in your browser
2. Open a Claude Code session in a separate terminal window
3. Ask Claude to help with something — read a file, write some DSP code, etc.
4. Watch the browser tab — new observations appear in the timeline as Claude works

---

## Part 4: A Typical Synth Dev Session

Here's exactly what happens when you use claude-mem during synth work.

### Morning: You Start a New Session

```bash
cd ~/my-synth-project
claude
```

Claude Code opens. In the first few seconds, claude-mem injects context automatically. You might see something like:

```
[claude-mem] Recent context loaded (3 sessions, 47 observations)

## Nov 3, 2025
| ID  | Time   | Type      | Title                                     |
|-----|--------|-----------|-------------------------------------------|
| #41 | 2:15pm | 🎛️ algo   | Moog ladder filter with resonance         |
| #42 | 2:47pm | 🔴 bugfix | Fixed aliasing in hard-sync oscillator    |
| #43 | 3:10pm | 🎵 sound  | Brass ensemble patch with filter sweep    |
| #44 | 4:30pm | ⚡ perf   | SIMD vectorization of wavetable oscillator|
```

Claude can now see what you were working on. You can just say "let's continue with the filter work" and it knows exactly what you mean.

### During the Session: Everything Is Automatic

As you work with Claude — reading files, writing code, running tests — claude-mem watches every tool Claude uses and quietly builds observations in the background. You don't do anything differently.

Each time Claude uses a tool (reads a file, runs a command, writes code), claude-mem captures what was learned or done and stores it as a structured observation.

### Asking Claude About Your History

You can ask Claude directly:

> "What filters have I implemented so far?"

> "How did I fix that aliasing issue last week?"

> "Show me the parameter ranges I used for the brass patch."

Claude will use its search tools to query your memory and give you a specific answer based on your actual work history.

---

## Part 5: The Web Viewer

Open `http://localhost:37777` in your browser. This is your memory dashboard.

### What You'll See

**Timeline View**: Every observation ever captured, in chronological order. Each entry shows:
- Type icon (🎛️ algorithm, 🎵 sound-design, ⚡ performance, etc.)
- Title and subtitle
- Key facts
- Which files were touched
- When it happened

**Search Bar**: Type anything — "lowpass filter", "SIMD", "aliasing", "brass patch" — and see matching results.

**Settings (gear icon)**: Configure how many past observations Claude sees at session start, which types to include, and more.

### Using the Viewer for Synth Work

The viewer is especially useful for:

- **Reviewing your DSP algorithm library**: See all filters, oscillators, and effects you've built
- **Finding past sound designs**: Browse presets and patch configurations
- **Tracking performance work**: See your CPU optimization history
- **Debugging audio issues**: Find past bug fixes and their solutions

---

## Part 6: Searching Your Memory

There are two ways to search: through Claude, or through the web viewer.

### Searching Through Claude

Just ask naturally in any Claude Code session:

> "Find my resonant filter implementations"

> "What oversampling techniques have I used to fix aliasing?"

> "Show me all the envelope configurations I've tried for brass sounds"

Claude will search its memory and show you relevant observations with full context.

### Using the Mem-Search Skill (Advanced)

In a Claude Code session, you can trigger a focused memory search:

```
/mem-search resonant lowpass filter
```

```
/mem-search SIMD oscillator optimization
```

```
/mem-search aliasing fix
```

This returns a structured list of matching observations with their IDs, types, and summaries.

### Fetching Full Details

If you want the full details of a specific observation you saw in the viewer:

```
http://localhost:37777/api/observation/41
```

(Replace `41` with the observation ID.)

---

## Part 7: What Gets Captured in Synth-Dev Mode

The `synth-dev` mode captures seven types of observations:

### 🎛️ Algorithm
Any DSP algorithm you implement or modify.

**Examples captured:**
- "Implemented Chamberlin SVF filter with multimode output (LP/BP/HP/notch)"
- "Added hard sync to sawtooth oscillator"
- "Implemented 4-pole resonant ladder filter"

**What's stored:** topology, parameter ranges, cutoff frequencies, resonance values, relevant files

---

### 🎵 Sound Design
Any patch, preset, or sound configuration you create or tune.

**Examples captured:**
- "Brass ensemble patch with fast attack, slow filter sweep"
- "Sub bass with detuned sawtooth and sub oscillator"
- "Pad with long ADSR and chorus effect"

**What's stored:** oscillator types, filter settings, envelope values, modulation routing, preset files

---

### ⚡ Performance
Any CPU or memory optimization.

**Examples captured:**
- "SIMD vectorization of wavetable oscillator — 42% CPU reduction"
- "Cache-friendly buffer layout for voice processing"
- "Removed denormal checks, replaced with DC offset trick"

**What's stored:** before/after metrics, techniques used, files changed

---

### 🔄 DSP Pattern
Reusable audio processing techniques you develop.

**Examples captured:**
- "Generic oversampling wrapper for any non-linear processor"
- "Smooth parameter update helper to prevent zipper noise"
- "Exponential frequency scaling utility"

**What's stored:** how the pattern works, when to use it, parameter details

---

### 🔴 Audio Bug Fix
Any audio artifact or bug you resolve.

**Examples captured:**
- "Fixed aliasing in oscillator above 4kHz using 4x oversampling"
- "Eliminated click on note-off by adding 5ms amplitude smoothing"
- "Fixed denormal explosion in reverb with DC offset injection"

**What's stored:** what the artifact was, what caused it, the solution, affected files

---

### 🔵 Discovery
Learning how existing DSP code or the project works.

**Examples captured:**
- "Voice stealing uses oldest-active strategy — see VoiceManager.cpp:127"
- "Filter topology uses Chamberlin SVF, not biquad"
- "Preset format is JSON with a `voice` array for each unison voice"

**What's stored:** what was learned, where the relevant code is

---

### ⚖️ Architecture
Signal flow or design decisions with rationale.

**Examples captured:**
- "Chose pre-filter distortion topology for analog warmth vs. post-filter"
- "Decided on 44.1kHz internal rate with 4x oversampling for non-linear stages"
- "Voice architecture: 8 voices, oldest-note stealing, mono portamento optional"

**What's stored:** the decision, the alternatives considered, the reasoning

---

## Part 8: Audio-Specific Concepts

Observations are also tagged with **concepts** that make them easier to find. These are the audio-specific concepts in synth-dev mode:

| Concept | What It Means |
|---------|---------------|
| `filter-design` | Lowpass, highpass, bandpass, resonance, Q factor |
| `oscillator` | Waveform generation, wavetables, sync, PWM |
| `envelope` | ADSR, envelope generators, mod sources |
| `modulation` | LFO, mod matrix, routing |
| `aliasing` | Nyquist issues, oversampling, band-limiting |
| `cpu-usage` | Performance measurements, profiling |
| `timbre` | Tonal character, warmth, brightness |
| `parameter-range` | Min/max values, scaling curves |
| `signal-flow` | Audio routing, processing chains |
| `voice-architecture` | Polyphony, voice stealing, note management |
| `stability` | Denormals, numerical edge cases |

When searching, you can use these concepts as search terms to get focused results.

---

## Part 9: Privacy

If you work on proprietary synth algorithms or patches you don't want stored, wrap them in a `<private>` tag in your conversation:

```
<private>
This filter topology is proprietary — don't store observations about this implementation.
</private>
```

Claude-mem strips out anything between `<private>` tags before it reaches the database. The tag stripping happens before any storage.

---

## Part 10: Configuration Options

Your settings live in `~/.claude-mem/settings.json`. Open it in any text editor.

### Most Useful Settings for Synth Work

```json
{
  "CLAUDE_MEM_MODE": "synth-dev",
  "CLAUDE_MEM_CONTEXT_OBSERVATIONS": "50",
  "CLAUDE_MEM_CONTEXT_FULL_COUNT": "5"
}
```

| Setting | Default | What It Does |
|---------|---------|--------------|
| `CLAUDE_MEM_MODE` | `"code"` | Which mode to use (`"synth-dev"` for audio work) |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `"50"` | How many past observations to show at session start |
| `CLAUDE_MEM_CONTEXT_FULL_COUNT` | `"5"` | How many observations to show with full narrative detail |
| `CLAUDE_MEM_LOG_LEVEL` | `"INFO"` | Set to `"DEBUG"` if troubleshooting |

You can also change all settings through the web viewer at `http://localhost:37777` (click the gear icon).

---

## Part 11: Troubleshooting

### "Claude doesn't seem to know about my past work"

1. Check the worker is running: `curl http://localhost:37777/api/health`
2. Check there are observations: open `http://localhost:37777` and look at the timeline
3. Check the mode: open `~/.claude-mem/settings.json` and confirm `CLAUDE_MEM_MODE` is `"synth-dev"`
4. Start a fresh session: the context is injected at session start, so close and reopen Claude Code

### "The web viewer isn't loading"

The worker service starts automatically when you open a Claude Code session. If the viewer isn't loading:

```bash
# Manually start the worker
bun ~/.claude/plugins/marketplaces/thedotmack/scripts/worker-service.cjs start
```

Or open a new Claude Code session, which will start it automatically.

### "No observations are appearing in the viewer"

Check that you're actively using Claude (not just chatting — Claude needs to use tools like reading files, writing code, running commands). claude-mem captures **tool use**, not conversation. If Claude is only responding with text and not using tools, nothing gets captured.

### "I want to see what's being captured right now"

Watch the worker logs live:

```bash
tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log
```

### "How do I restart the worker after changing settings?"

```bash
bun ~/.claude/plugins/marketplaces/thedotmack/scripts/worker-service.cjs restart
```

Or start a new Claude Code session (it will restart automatically).

### "I want to start fresh / delete all memory"

Delete the database file:

```bash
rm ~/.claude-mem/claude-mem.db
```

The worker will create a fresh empty database on next startup.

---

## Part 12: Day-to-Day Workflow Summary

Here's the simplest possible summary of how to use claude-mem daily:

### You Don't Have To Do Anything Special

1. `cd` into your synth project
2. Run `claude`
3. Work normally — ask Claude to help you write filters, debug aliasing, design sounds, optimize code
4. End the session when you're done

That's it. claude-mem captures everything automatically.

### When You Want to Use Your Memory

- **Ask Claude**: "What filters have I implemented?" / "How did I fix that clicking sound?"
- **Open the viewer**: `http://localhost:37777`
- **Search**: type `/mem-search resonant filter` in a Claude session

### When Starting a New Project

Add to the project's `CLAUDE.md`:
```markdown
## Claude-Mem Mode
Use synth-dev mode for this project.
```

### When You Want to Keep Something Private

Wrap it in `<private>...</private>` in your conversation.

---

## Quick Reference

| Task | How |
|------|-----|
| Install | `/plugin marketplace add thedotmack/claude-mem` then `/plugin install claude-mem` |
| Enable synth mode | Add `Use synth-dev mode` to project `CLAUDE.md` |
| Open viewer | Browser: `http://localhost:37777` |
| Search memory | Ask Claude, or type `/mem-search <query>` |
| Check worker | `curl http://localhost:37777/api/health` |
| Restart worker | `bun ~/.claude/plugins/marketplaces/thedotmack/scripts/worker-service.cjs restart` |
| Watch logs | `tail -f ~/.claude-mem/logs/worker-$(date +%Y-%m-%d).log` |
| Keep something private | Wrap in `<private>...</private>` |
| Change settings | Edit `~/.claude-mem/settings.json` or use the viewer gear icon |
| Start fresh | `rm ~/.claude-mem/claude-mem.db` |

---

## What To Expect

### First Session (After Install)
- Slight delay (2-5 seconds) while dependencies install
- No memory context yet (empty — you haven't worked yet)
- Everything else works normally

### After a Few Sessions
- Context appears at session start showing recent work
- Claude can answer "what did I do last time?" accurately
- The viewer timeline fills up with your history

### After a Few Weeks
- Claude has rich context about your DSP patterns and preferences
- "How did I implement X?" returns specific, accurate answers
- You'll notice Claude suggesting approaches that match your established patterns

---

**That's everything.** Install, add the `synth-dev` line to your `CLAUDE.md`, and start coding. The memory system handles itself.

Questions or issues: https://github.com/thedotmack/claude-mem/issues
