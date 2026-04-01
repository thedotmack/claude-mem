---
id: "20-design-desk"
title: "Design Desk"
category: fullstack
timeout_hint: "8h"
industry_baseline:
  source: openai
  reference_cost_usd: null
  reference_duration_seconds: 90000
  reference_architecture: "Single agent with 4-file durable memory (GPT-5.3-Codex)"
smoke_tests:
  - name: "homepage_loads"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
  - name: "has_canvas"
    command: "curl -s http://localhost:3000"
    expected: "contains:canvas"
---

# Design Desk

Build a collaborative design tool with a canvas editor, prototyping capabilities, live collaboration, and React + Tailwind code export. This is a comparison target against OpenAI's Codex benchmark.

## Requirements

### Canvas Editor
1. **Infinite Canvas**: Pan and zoom on an infinite 2D canvas
2. **Shape Tools**: Rectangle, ellipse, line, polygon, freehand draw
3. **Text Tool**: Add and edit text elements with font, size, color, alignment controls
4. **Image Import**: Upload and place images on the canvas
5. **Selection**: Click to select, shift-click for multi-select, drag for marquee selection
6. **Transform**: Move, resize, rotate selected elements. Snap to grid optional.
7. **Layers Panel**: Z-order management — bring to front, send to back, reorder layers
8. **Undo/Redo**: Full undo/redo stack for all operations

### Prototyping
1. **Artboards/Frames**: Create named frames that act as "screens" in a prototype
2. **Interactions**: Link elements to frames (e.g., clicking a button navigates to another frame)
3. **Prototype Preview**: Play mode that navigates between frames based on defined interactions
4. **Transition Animations**: Basic transitions between frames (fade, slide left/right)

### Collaboration
1. **Real-Time Cursors**: See other users' cursors on the canvas in real-time (via WebSocket)
2. **Presence Indicators**: Show which users are currently viewing the design
3. **Conflict-Free Editing**: Multiple users can edit different elements simultaneously
4. **Chat**: Simple in-app chat for collaborators

### Code Export
1. **React + Tailwind Export**: Select a frame and export it as a React component with Tailwind CSS classes
2. **HTML/CSS Export**: Alternative export as plain HTML + CSS
3. **Component Naming**: Each element can have a custom component name for export
4. **Responsive Hints**: Mark elements with responsive behavior (flex, grid) that translates to the exported code

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express + WebSocket (Socket.io) for collaboration
- SQLite for project persistence
- Frontend: Canvas API (HTML5 Canvas) for rendering the design surface
- Real-time sync via WebSocket for collaboration features
- Export logic runs client-side (DOM generation → code string)

### API Endpoints
- `GET /` — Design editor application
- `POST /projects` — Create project
- `GET /projects` — List projects
- `GET /projects/:id` — Load project
- `PUT /projects/:id` — Save project state
- `POST /projects/:id/export` — Export frame as code
- WebSocket events for real-time collaboration

### Data Model
- **Project**: id, name, canvas_state (JSON), created_at, updated_at
- **Frame**: id, project_id, name, x, y, width, height
- **Element**: id, frame_id, type (rect/ellipse/text/image/line), properties (JSON: x, y, width, height, rotation, fill, stroke, text, font, etc.), z_index
- **Interaction**: id, source_element_id, target_frame_id, trigger (click/hover), transition (fade/slide)
- **Collaborator**: socket_id, user_name, cursor_x, cursor_y, active_project_id

### Code Export Format
Given a frame with elements, the React export should produce:
```jsx
export function LoginScreen() {
  return (
    <div className="relative w-[375px] h-[812px] bg-white">
      <div className="absolute top-[120px] left-[32px] text-2xl font-bold text-gray-900">
        Welcome Back
      </div>
      <input className="absolute top-[200px] left-[32px] w-[311px] h-[48px] border rounded-lg px-4" />
      <button className="absolute top-[280px] left-[32px] w-[311px] h-[48px] bg-blue-600 text-white rounded-lg">
        Sign In
      </button>
    </div>
  );
}
```

## Testable Deliverables
- Server starts on port 3000
- Editor loads with an interactive canvas element
- Shapes can be created and manipulated on the canvas
- Frames can be defined and linked with interactions
- Prototype preview mode navigates between frames
- Real-time cursors visible for multiple connected users
- Code export generates valid React + Tailwind components
- Projects can be saved and loaded
