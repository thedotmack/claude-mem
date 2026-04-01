---
id: "17-retroforge"
title: "RetroForge Game Maker"
category: fullstack
timeout_hint: "8h"
industry_baseline:
  source: anthropic
  reference_cost_usd: 200
  reference_duration_seconds: 21600
  reference_architecture: "3-agent pipeline (Planner → Generator → Evaluator)"
smoke_tests:
  - name: "homepage_loads"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
  - name: "editor_has_canvas"
    command: "curl -s http://localhost:3000"
    expected: "contains:canvas"
---

# RetroForge Game Maker

Build a retro game creation tool in the browser. Users design pixel-art sprites, build tile-based levels, wire up game logic, and playtest their creations — all within a single web application. This is a comparison target against Anthropic's multi-agent benchmark.

## Requirements

### Sprite Editor
1. **Pixel Canvas**: Grid-based pixel drawing canvas (16x16, 32x32, or 64x64 sprite sizes)
2. **Drawing Tools**: Pencil, eraser, fill bucket, color picker, eyedropper
3. **Color Palette**: Preset retro palette (NES, Game Boy, or custom) with ability to customize colors
4. **Animation Frames**: Create multiple frames per sprite for animation; preview playback at configurable FPS
5. **Sprite Library**: Save sprites to a library for use in the level editor

### Level Editor
1. **Tile Map**: Grid-based level editor where users place tiles (sprites) on a map
2. **Layers**: Support at least 2 layers (background and foreground/collision)
3. **Tile Painting**: Paint tiles by clicking/dragging on the map grid
4. **Resize**: Configurable map dimensions (width x height in tiles)
5. **Object Placement**: Place special objects (player start, enemies, collectibles, exit) on the map

### Game Engine
1. **Player Movement**: Arrow key or WASD movement with collision detection against foreground tiles
2. **Collectibles**: Player can pick up collectible objects (score increases)
3. **Enemies**: Basic enemies with simple patrol AI (walk back and forth)
4. **Win Condition**: Reaching the exit tile completes the level
5. **Game Loop**: Runs at 60fps with requestAnimationFrame

### Playtest Mode
1. **Run Game**: Click "Play" to playtest the current level in an embedded game window
2. **Reset**: Return to editor with one click
3. **Debug Overlay**: Optional overlay showing collision boxes and object IDs

### Technical Requirements
- Serves on **port 3000**
- Node.js backend for serving the app and saving/loading projects
- Frontend: Canvas API for rendering, vanilla JS or lightweight framework
- Save/Load projects as JSON
- No external game engine libraries — build the game logic from scratch

### API Endpoints
- `GET /` — Main editor application
- `POST /projects` — Save a project
- `GET /projects` — List saved projects
- `GET /projects/:id` — Load a project
- `DELETE /projects/:id` — Delete a project

### Data Model
- **Project**: id, name, sprites (JSON), levels (JSON), settings, created_at, updated_at
- **Sprite**: name, width, height, frames (array of pixel data arrays), palette
- **Level**: name, width, height, layers (array of tile arrays), objects (array with type, position)

## Testable Deliverables
- Server starts on port 3000
- Editor UI loads with canvas element for sprite editing
- Sprites can be drawn and saved
- Level editor allows tile placement
- Playtest mode runs the game with player movement
- Projects can be saved and loaded
