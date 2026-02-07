# Synth Development Workflow with Claude-Mem

This guide shows how to integrate claude-mem into your synthesizer design and audio DSP programming workflow.

## Overview

Claude-mem's `synth-dev` mode captures and organizes your audio development work across sessions, creating a searchable knowledge base of:

- **DSP Algorithms**: Filter designs, oscillators, effects processors
- **Sound Designs**: Patches, presets, parameter configurations
- **Performance Work**: SIMD optimizations, profiling results, CPU improvements
- **Audio Bugs**: Aliasing fixes, artifact removal, stability improvements
- **Architecture Decisions**: Signal flow, voice management, routing

## Quick Start

### 1. Enable Synth-Dev Mode

Add to your project's `CLAUDE.md` or `.claude/CLAUDE.md`:

```markdown
## Mode Configuration

Use synth-dev mode for this project - we're building audio synthesizers and DSP code.
```

Or set it in your `~/.claude-mem/settings.json`:

```json
{
  "defaultMode": "synth-dev"
}
```

### 2. Work Normally

Claude-mem runs in the background, automatically capturing:

- Code you write for DSP algorithms
- Parameters you configure for sound patches
- Performance improvements you make
- Audio bugs you fix
- Architectural decisions you make

### 3. Search Your History

Use the `/mem-search` skill to find past work:

```
/mem-search "resonant lowpass filter implementation"
/mem-search "brass patch with filter envelope"
/mem-search "SIMD optimization"
/mem-search "aliasing fix"
```

## Observation Types

The `synth-dev` mode captures seven types of audio work:

| Type | When to Use | Example |
|------|-------------|---------|
| **algorithm** | Implemented or modified a DSP algorithm | "Moog ladder filter with resonance" |
| **sound-design** | Created a patch, preset, or sound | "Analog bass with sub-oscillator" |
| **performance** | Optimized CPU/memory usage | "SIMD vectorization reduced CPU by 40%" |
| **dsp-pattern** | Reusable audio processing technique | "Oversampling wrapper for antialiasing" |
| **audio-bugfix** | Fixed clicks, pops, aliasing, artifacts | "Fixed denormal issues in reverb tail" |
| **discovery** | Learned how existing DSP code works | "Understood voice stealing algorithm" |
| **architecture** | Made signal flow or design decision | "Chose pre-filter distortion topology" |

## Audio Concepts

Observations are tagged with relevant concepts for better searchability:

- **filter-design**: Lowpass, highpass, bandpass, resonance, Q factor
- **oscillator**: Wavetables, sync, PWM, waveform generation
- **envelope**: ADSR, envelope generators, modulation
- **modulation**: LFO, mod matrix, routing
- **aliasing**: Nyquist, oversampling, band-limiting
- **cpu-usage**: Performance characteristics, profiling
- **timbre**: Tonal quality, character, warmth
- **parameter-range**: Min/max values, scaling, exponential curves
- **signal-flow**: Audio routing, processing chains
- **voice-architecture**: Polyphony, voice stealing, note priority
- **stability**: Denormals, numerical issues, edge cases

## Example Workflows

### Workflow 1: Implementing a Filter

```bash
# You work on a filter implementation
# Claude-mem automatically captures:
```

**Observation Created:**
```xml
<observation>
  <type>algorithm</type>
  <title>State Variable Filter with multimode output</title>
  <subtitle>Chamberlin topology providing LP, BP, HP, and notch outputs simultaneously</subtitle>
  <facts>
    <fact>Filter cutoff range: 20Hz to 20kHz with exponential mapping</fact>
    <fact>Resonance Q range: 0.707 to 20.0 for self-oscillation</fact>
    <fact>Simultaneous LP, BP, HP, and notch outputs from single topology</fact>
    <fact>Implemented in src/dsp/filters/SVF.cpp</fact>
  </facts>
  <concepts>
    <concept>filter-design</concept>
    <concept>parameter-range</concept>
    <concept>signal-flow</concept>
  </concepts>
  <files>
    <file>src/dsp/filters/SVF.cpp</file>
    <file>src/dsp/filters/SVF.h</file>
  </files>
</observation>
```

**Later, you can search:**
```
/mem-search "state variable filter"
/mem-search "multimode filter implementation"
/mem-search "Chamberlin topology"
```

### Workflow 2: Designing a Sound

```bash
# You create a brass patch
# Claude-mem captures the configuration:
```

**Observation Created:**
```xml
<observation>
  <type>sound-design</type>
  <title>Brass ensemble patch with filter sweep</title>
  <subtitle>Bright brass sound using sawtooth oscillator and envelope-controlled filter</subtitle>
  <facts>
    <fact>Oscillator: sawtooth wave with slight detune (+5 cents) for width</fact>
    <fact>Filter: lowpass at 800Hz base, +3 octave envelope modulation</fact>
    <fact>Filter envelope: attack 10ms, decay 400ms, sustain 30%, release 200ms</fact>
    <fact>Amp envelope: attack 5ms, decay 100ms, sustain 80%, release 150ms</fact>
    <fact>Slight chorus effect (rate 0.5Hz, depth 10%) for ensemble character</fact>
  </facts>
  <concepts>
    <concept>oscillator</concept>
    <concept>envelope</concept>
    <concept>filter-design</concept>
    <concept>timbre</concept>
  </concepts>
  <files>
    <file>presets/brass/brass-ensemble-001.preset</file>
  </files>
</observation>
```

**Search later:**
```
/mem-search "brass patch"
/mem-search "filter envelope sweep"
/mem-search "sawtooth detune"
```

### Workflow 3: Performance Optimization

```bash
# You optimize oscillator code with SIMD
# Claude-mem tracks the improvement:
```

**Observation Created:**
```xml
<observation>
  <type>performance</type>
  <title>SIMD vectorization of wavetable oscillator</title>
  <subtitle>Process 4 voices simultaneously using SSE intrinsics, reduced CPU by 42%</subtitle>
  <facts>
    <fact>Original oscillator: 8.2% CPU for 64 voices</fact>
    <fact>Optimized oscillator: 4.8% CPU for 64 voices (42% reduction)</fact>
    <fact>Uses _mm_load_ps and _mm_mul_ps for 4-way parallel processing</fact>
    <fact>Aligned wavetable buffers with __attribute__((aligned(16)))</fact>
    <fact>Benchmark results in benchmarks/oscillator-simd-results.txt</fact>
  </facts>
  <concepts>
    <concept>cpu-usage</concept>
    <concept>oscillator</concept>
  </concepts>
  <files>
    <file>src/dsp/oscillators/WavetableOsc.cpp</file>
    <file>benchmarks/oscillator-simd-results.txt</file>
  </files>
</observation>
```

**Search later:**
```
/mem-search "SIMD optimization"
/mem-search "wavetable performance"
/mem-search "CPU reduction"
```

### Workflow 4: Fixing Audio Bugs

```bash
# You fix aliasing in a hard-sync oscillator
# Claude-mem documents the solution:
```

**Observation Created:**
```xml
<observation>
  <type>audio-bugfix</type>
  <title>Fixed aliasing in hard-sync oscillator with 4x oversampling</title>
  <subtitle>Eliminated harsh aliasing artifacts by processing sync discontinuities at higher sample rate</subtitle>
  <facts>
    <fact>Original oscillator produced audible aliasing above 2kHz sync frequency</fact>
    <fact>Implemented 4x oversampling using polyphase FIR filters</fact>
    <fact>Upsampling filter: 128-tap with cutoff at 0.45 * sample_rate</fact>
    <fact>Downsampling filter: 128-tap with cutoff at 0.45 * sample_rate</fact>
    <fact>CPU cost increased by 60% but aliasing eliminated up to 8kHz sync</fact>
  </facts>
  <concepts>
    <concept>aliasing</concept>
    <concept>oscillator</concept>
    <concept>cpu-usage</concept>
  </concepts>
  <files>
    <file>src/dsp/oscillators/HardSyncOsc.cpp</file>
    <file>src/dsp/oversampling/OversamplingEngine.h</file>
  </files>
</observation>
```

**Search later:**
```
/mem-search "aliasing fix"
/mem-search "hard sync oversampling"
/mem-search "FIR filter antialiasing"
```

## Integration with Development Tools

### VST/AU Plugin Development

Claude-mem captures:
- Plugin parameter mappings
- VST3/AU specific implementations
- GUI-to-DSP communication patterns
- Plugin validation issues and fixes

### DAW Testing

When testing in DAWs, claude-mem records:
- DAW-specific bugs discovered
- Host automation behavior
- Buffer size edge cases
- Plugin state save/restore issues

### Audio Unit Tests

Claude-mem tracks:
- Test methodologies for DSP code
- Edge case discoveries
- Numerical precision requirements
- Benchmark baselines

## Best Practices

### 1. Include Specific Parameters

When implementing audio code, include exact values:

✅ **Good**: "Filter cutoff range: 20Hz to 20kHz with exponential mapping (A = 20 * 2^(10*x))"

❌ **Bad**: "Filter has cutoff control"

### 2. Document Sound Characteristics

Describe timbral qualities:

✅ **Good**: "Warm analog character from soft clipping, slight detuning adds width"

❌ **Bad**: "Sounds good"

### 3. Track Performance Metrics

Include concrete measurements:

✅ **Good**: "CPU reduced from 8.2% to 4.8% (42% improvement) for 64 voices"

❌ **Bad**: "Made it faster"

### 4. Record Parameter Ranges

Capture the ranges that work:

✅ **Good**: "Resonance Q: 0.707 (no resonance) to 20.0 (self-oscillation at Q=18.0)"

❌ **Bad**: "Resonance parameter added"

### 5. Note Audio Artifacts Fixed

Be specific about artifacts:

✅ **Good**: "Fixed zipper noise when modulating cutoff by using exponential smoothing (time constant = 5ms)"

❌ **Bad**: "Fixed clicking sound"

## Search Patterns

### Finding Implementations

```bash
# Find all filter designs
/mem-search "filter-design" --concepts

# Find oscillator implementations
/mem-search "oscillator" --concepts

# Find envelope code
/mem-search "envelope ADSR"
```

### Finding Performance Work

```bash
# Find all optimizations
/mem-search "performance optimization"

# Find CPU improvements
/mem-search "cpu-usage SIMD"

# Find profiling results
/mem-search "benchmark profile"
```

### Finding Bug Fixes

```bash
# Find aliasing solutions
/mem-search "aliasing oversampling"

# Find stability fixes
/mem-search "denormal numerical stability"

# Find artifact removals
/mem-search "audio-bugfix clicks pops"
```

### Finding Sound Designs

```bash
# Find bass patches
/mem-search "sound-design bass"

# Find specific timbres
/mem-search "timbre brass analog"

# Find modulation techniques
/mem-search "modulation LFO matrix"
```

## Advanced Features

### Cross-Session Context

Claude-mem remembers across sessions, so you can:

1. **Session 1**: Implement a Moog filter
2. **Session 2**: Ask "How did I implement that resonant filter last week?"
3. **Session 3**: Build on that filter design for a new sound

### Pattern Recognition

Claude-mem identifies patterns in your work:

- "You've implemented 3 different lowpass filters - here's how they differ"
- "This aliasing fix is similar to what you did in the oscillator code"
- "Your envelope configurations typically use fast attacks (5-10ms)"

### Timeline Analysis

Use the viewer UI at `http://localhost:37777` to:

- See a timeline of your synth development
- Track evolution of a specific algorithm
- Review sound design iterations
- Find when performance regressions occurred

## Configuration

### Custom Observation Types

If you need additional observation types, edit `plugin/modes/synth-dev.json`:

```json
{
  "observation_types": [
    {
      "id": "midi-implementation",
      "label": "MIDI Implementation",
      "description": "MIDI message handling and CC mapping",
      "emoji": "🎹",
      "work_emoji": "🛠️"
    }
  ]
}
```

### Custom Concepts

Add domain-specific concepts:

```json
{
  "observation_concepts": [
    {
      "id": "wavetable",
      "label": "Wavetable",
      "description": "Wavetable synthesis techniques"
    }
  ]
}
```

## Integration with Existing Tools

### Git Integration

Claude-mem works alongside your git workflow:
- Observations are tied to git commits
- Search can filter by branch or commit range
- Memory persists across branches

### Documentation Generation

Export observations to markdown:

```bash
/mem-search "algorithm" --format markdown > docs/dsp-algorithms.md
```

### Team Collaboration

Share knowledge bases:
- Export observations for team members
- Import observations from colleagues
- Build shared DSP pattern library

## Troubleshooting

### Memory Not Capturing Audio Work

Check that `synth-dev` mode is active:

```bash
# View current mode
cat ~/.claude-mem/settings.json | grep mode
```

### Search Not Finding Audio Concepts

Use audio-specific terms:

✅ **Good**: "filter cutoff resonance Q"

❌ **Bad**: "the filter thing"

### Performance Overhead

Claude-mem runs asynchronously with minimal overhead:
- Memory capture: < 1ms per tool use
- Search queries: < 100ms typical
- No impact on audio processing thread

## Next Steps

1. **Start using it**: Just code normally, claude-mem captures automatically
2. **Search regularly**: Use `/mem-search` to find past implementations
3. **Review timeline**: Check `http://localhost:37777` to see your progress
4. **Refine searches**: Learn which terms work best for your workflow
5. **Export knowledge**: Share observations with your team

## Example Project Structure

```
my-synth-project/
├── src/
│   ├── dsp/
│   │   ├── filters/        # Filter implementations
│   │   ├── oscillators/    # Oscillator code
│   │   ├── envelopes/      # Envelope generators
│   │   └── effects/        # Effects processors
│   ├── voice/
│   │   ├── Voice.cpp       # Voice architecture
│   │   └── VoiceManager.cpp
│   └── plugin/
│       └── SynthPlugin.cpp
├── presets/                # Sound design patches
│   ├── bass/
│   ├── lead/
│   ├── pad/
│   └── brass/
├── benchmarks/             # Performance results
└── tests/                  # Audio unit tests
    └── dsp/

# Claude-mem automatically organizes observations by:
# - File paths (links to code)
# - Concepts (filter-design, oscillator, etc.)
# - Types (algorithm, sound-design, performance)
# - Timeline (when work was done)
```

---

**Ready to enhance your synth workflow?** Claude-mem is already running - just start coding and search when you need to remember!
