---
id: "18-browser-daw"
title: "Browser Digital Audio Workstation"
category: fullstack
timeout_hint: "6h"
industry_baseline:
  source: anthropic
  reference_cost_usd: 124.70
  reference_duration_seconds: 13800
  reference_architecture: "3-agent pipeline (Planner → Generator → Evaluator)"
smoke_tests:
  - name: "homepage_loads"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
  - name: "has_audio_elements"
    command: "curl -s http://localhost:3000"
    expected: "contains:audio"
---

# Browser Digital Audio Workstation

Build a browser-based Digital Audio Workstation (DAW) with multi-track audio editing, a timeline view, audio effects, and mixing capabilities. This is a comparison target against Anthropic's multi-agent benchmark.

## Requirements

### Timeline & Tracks
1. **Multi-Track Timeline**: Horizontal timeline with multiple audio tracks stacked vertically
2. **Waveform Display**: Show audio waveforms on each track
3. **Playback Controls**: Play, pause, stop, seek. Playhead moves across the timeline during playback.
4. **Zoom**: Zoom in/out on the timeline (horizontal zoom for time resolution)
5. **Track Controls**: Each track has: name, volume slider, mute/solo buttons, pan knob

### Audio Operations
1. **Import Audio**: Upload audio files (WAV, MP3) and place them on tracks
2. **Record**: Record audio from the microphone onto a track (using Web Audio API + getUserMedia)
3. **Cut/Split**: Split an audio clip at the playhead position
4. **Move Clips**: Drag audio clips along the timeline or between tracks
5. **Trim**: Drag clip edges to trim start/end

### Effects & Mixing
1. **Built-in Effects**: At least 3 effects: reverb, delay, EQ (low/mid/high bands)
2. **Effect Chain**: Each track can have multiple effects in a chain
3. **Master Volume**: Master output volume control
4. **Mixer View**: Alternative view showing all track volumes, pans, and effects as a mixing console

### Export
1. **Export Mix**: Render all tracks to a single audio file (WAV) for download
2. **Project Save/Load**: Save the project state (track layout, clip positions, effect settings) and reload it

### Technical Requirements
- Serves on **port 3000**
- Node.js backend for serving the app and handling project saves
- Web Audio API for all audio processing (playback, effects, recording, mixing)
- Canvas or SVG for timeline and waveform rendering
- No external audio processing libraries on the backend — all audio work in the browser

### API Endpoints
- `GET /` — DAW application
- `POST /projects` — Save project state
- `GET /projects` — List projects
- `GET /projects/:id` — Load project
- `POST /upload` — Upload audio file (returns file ID for use in project)
- `GET /audio/:id` — Stream an uploaded audio file

### Data Model
- **Project**: id, name, bpm, tracks (JSON), created_at
- **Track**: name, volume, pan, mute, solo, effects (array), clips (array)
- **Clip**: audio_file_id, start_time, duration, offset, track_index
- **Effect**: type (reverb/delay/eq), parameters (JSON)
- **AudioFile**: id, original_name, file_path, duration_seconds, sample_rate

## Testable Deliverables
- Server starts on port 3000
- DAW interface loads with timeline and track controls
- Audio files can be uploaded and placed on tracks
- Playback works with multiple tracks
- Effects can be added to tracks
- Project can be saved and reloaded
- Mix can be exported as audio
