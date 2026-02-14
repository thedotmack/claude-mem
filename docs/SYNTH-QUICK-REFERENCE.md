# Synth-Dev Mode Quick Reference

## Enable Synth-Dev Mode

**Option 1: Project-specific** (in `CLAUDE.md` or `.claude/CLAUDE.md`):
```markdown
Use synth-dev mode for this audio DSP project.
```

**Option 2: Global default** (in `~/.claude-mem/settings.json`):
```json
{
  "defaultMode": "synth-dev"
}
```

## Observation Types

| Type | Use For | Emoji |
|------|---------|-------|
| `algorithm` | DSP algorithms (filters, oscillators, effects) | 🎛️ |
| `sound-design` | Patches, presets, sound configurations | 🎵 |
| `performance` | CPU/memory optimizations, SIMD | ⚡ |
| `dsp-pattern` | Reusable audio processing techniques | 🔄 |
| `audio-bugfix` | Aliasing, clicks, pops, artifacts | 🔴 |
| `discovery` | Learning existing DSP code | 🔵 |
| `architecture` | Signal flow, voice management decisions | ⚖️ |

## Concepts

| Concept | Examples |
|---------|----------|
| `filter-design` | Lowpass, highpass, bandpass, resonance, Q |
| `oscillator` | Wavetables, sync, PWM, waveforms |
| `envelope` | ADSR, envelope generators |
| `modulation` | LFO, mod matrix, routing |
| `aliasing` | Nyquist, oversampling, band-limiting |
| `cpu-usage` | Performance, profiling, benchmarks |
| `timbre` | Tonal quality, character, warmth |
| `parameter-range` | Min/max, scaling, mapping |
| `signal-flow` | Audio routing, processing chains |
| `voice-architecture` | Polyphony, voice stealing |
| `stability` | Denormals, numerical issues |

## Common Search Patterns

### Find Implementations
```bash
/mem-search "resonant filter implementation"
/mem-search "oscillator wavetable"
/mem-search "ADSR envelope code"
```

### Find Sound Designs
```bash
/mem-search "bass patch"
/mem-search "brass sound"
/mem-search "filter sweep"
```

### Find Performance Work
```bash
/mem-search "SIMD optimization"
/mem-search "CPU reduction"
/mem-search "performance benchmark"
```

### Find Bug Fixes
```bash
/mem-search "aliasing fix"
/mem-search "denormal stability"
/mem-search "click removal"
```

### Search by Concept
```bash
/mem-search "filter-design" --concepts
/mem-search "cpu-usage" --concepts
/mem-search "aliasing" --concepts
```

### Search by Type
```bash
/mem-search "algorithm" --type
/mem-search "sound-design" --type
/mem-search "performance" --type
```

## Example Observations

### Filter Implementation
```
Type: algorithm
Title: Moog ladder filter with resonance
Concepts: filter-design, parameter-range, timbre
Facts:
  - Cutoff range: 20Hz to 20kHz (exponential)
  - Q range: 0.5 to 20.0 for self-oscillation
  - Soft clipping via tanh() for saturation
Files: src/dsp/filters/MoogLadder.cpp
```

### Sound Design
```
Type: sound-design
Title: Analog bass with sub-oscillator
Concepts: oscillator, envelope, timbre
Facts:
  - Sawtooth main + square sub (one octave down)
  - Filter envelope: 5ms attack, 200ms decay
  - Cutoff modulation: +2400 cents
Files: presets/bass/analog-bass-001.preset
```

### Performance Optimization
```
Type: performance
Title: SIMD vectorization of oscillator
Concepts: cpu-usage, oscillator
Facts:
  - CPU reduced from 8.2% to 4.8% (42% improvement)
  - Process 4 voices in parallel with SSE
  - Uses _mm_load_ps and _mm_mul_ps
Files: src/dsp/oscillators/WavetableOsc.cpp
```

### Bug Fix
```
Type: audio-bugfix
Title: Fixed aliasing with 4x oversampling
Concepts: aliasing, oscillator, cpu-usage
Facts:
  - Eliminated aliasing up to 8kHz sync frequency
  - 128-tap FIR filters for up/downsampling
  - CPU cost increased by 60%
Files: src/dsp/oscillators/HardSyncOsc.cpp
```

## Best Practices

### ✅ DO Include Specific Details
- Parameter ranges: "20Hz to 20kHz with exponential scaling"
- Performance metrics: "CPU reduced from 8.2% to 4.8%"
- Audio characteristics: "Warm analog character from soft clipping"
- Mathematical details: "Q = 0.707 (Butterworth) to 20.0 (self-oscillation)"

### ❌ DON'T Be Vague
- ~~"Added filter"~~ → "Implemented Moog ladder lowpass with resonance"
- ~~"Made it faster"~~ → "SIMD optimization reduced CPU by 42%"
- ~~"Sounds good"~~ → "Warm brass timbre with bright attack and dark sustain"
- ~~"Fixed bug"~~ → "Eliminated aliasing above 2kHz using 4x oversampling"

## Viewer UI

Access the memory viewer at: **http://localhost:37777**

Features:
- Timeline of all synth development work
- Filter by observation type and concepts
- Search with full-text and semantic search
- Export observations to markdown

## Keyboard Shortcuts in Claude Code

- `/mem-search <query>` - Search your synth development history
- `Ctrl+Shift+M` - Open memory viewer (if keybinding configured)

## File Locations

| Path | Purpose |
|------|---------|
| `~/.claude-mem/claude-mem.db` | SQLite database of observations |
| `~/.claude-mem/settings.json` | Configuration (mode selection) |
| `~/.claude-mem/chroma/` | Vector embeddings for semantic search |
| `plugin/modes/synth-dev.json` | Mode definition (customizable) |

## Customization

### Add Custom Observation Type

Edit `plugin/modes/synth-dev.json`:

```json
{
  "observation_types": [
    {
      "id": "midi-implementation",
      "label": "MIDI Implementation",
      "description": "MIDI handling and CC mapping",
      "emoji": "🎹",
      "work_emoji": "🛠️"
    }
  ]
}
```

### Add Custom Concept

```json
{
  "observation_concepts": [
    {
      "id": "wavetable",
      "label": "Wavetable",
      "description": "Wavetable synthesis"
    }
  ]
}
```

After editing, rebuild:
```bash
npm run build-and-sync
```

## Integration Examples

### VST Plugin Development
Claude-mem captures:
- Plugin parameter mappings
- VST3/AU implementations
- State save/restore
- Host automation issues

### Audio Unit Tests
Claude-mem tracks:
- DSP test methodologies
- Edge case discoveries
- Numerical precision requirements
- Benchmark baselines

### DAW Testing
Claude-mem records:
- DAW-specific bugs
- Buffer size edge cases
- Plugin validation fixes

## Troubleshooting

**Mode not active?**
```bash
cat ~/.claude-mem/settings.json | grep mode
```

**Memory not capturing?**
- Check worker service: `curl http://localhost:37777/health`
- Check logs: `tail -f ~/.claude-mem/logs/worker.log`

**Search not working?**
- Use audio-specific terms
- Try concept-based search: `--concepts`
- Check viewer UI for full-text search

**Performance issues?**
- Memory capture is async (< 1ms overhead)
- No impact on audio processing thread
- Search typically < 100ms

## Links

- **Full Documentation**: See `docs/SYNTH-WORKFLOW.md`
- **Mode Configuration**: `plugin/modes/synth-dev.json`
- **Viewer UI**: http://localhost:37777
- **GitHub Issues**: https://github.com/thedotmack/claude-mem/issues

---

**Happy synth development!** 🎛️🎵
