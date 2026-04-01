---
id: "19-dutch-art-museum"
title: "Dutch Art Museum Website"
category: frontend
timeout_hint: "4h"
industry_baseline:
  source: anthropic
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: "3-agent pipeline, 10 iterations"
smoke_tests:
  - name: "homepage_loads"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
  - name: "has_doctype"
    command: "curl -s http://localhost:3000"
    expected: "contains:DOCTYPE"
---

# Dutch Art Museum Website

Build an immersive Dutch Art Museum website featuring CSS 3D spatial elements, elegant typography, and a gallery experience that evokes walking through a physical museum. This is a comparison target against Anthropic's multi-agent frontend benchmark.

## Requirements

### Gallery Experience
1. **3D Room Navigation**: Use CSS 3D transforms (perspective, rotateY, translateZ) to create the sensation of walking through museum rooms
2. **Room Layout**: At least 3 interconnected rooms, each with a distinct theme (e.g., Golden Age, Modern Dutch, Photography)
3. **Wall-Mounted Art**: Artwork displayed on "walls" using CSS 3D perspective — paintings appear to hang in 3D space
4. **Smooth Transitions**: Navigate between rooms with smooth CSS transitions or animations
5. **Lighting Effects**: Subtle CSS shadow/gradient effects simulating museum lighting (spotlights on paintings)

### Art Display
1. **Artwork Cards**: Each artwork shows: image, title, artist, year, medium, description
2. **Detail View**: Click an artwork to see a full-screen detail view with zoom capability
3. **Artist Info**: Artist biographical information accessible from the artwork detail view
4. **Collection Data**: Include at least 15 artworks across the rooms with real or realistic Dutch art data (Rembrandt, Vermeer, Mondrian, Van Gogh, etc.)

### Design & Typography
1. **Museum Aesthetic**: Muted color palette (cream walls, dark frames, warm accent colors)
2. **Elegant Typography**: Use serif fonts for headings (playfair, georgia, or similar), clean sans-serif for body text
3. **Responsive**: Works on desktop (full 3D experience) and gracefully degrades on mobile (card-based layout)
4. **Loading States**: Skeleton screens or elegant loading animations for images

### Interactive Elements
1. **Audio Guide**: Optional audio descriptions (can use placeholder audio or text-to-speech)
2. **Floor Plan**: A minimap showing the museum layout with current position highlighted
3. **Bookmark Favorites**: Save favorite artworks (persists in localStorage)
4. **Search/Filter**: Search artworks by artist, period, or medium

### Technical Requirements
- Serves on **port 3000**
- Node.js backend (Express) serving static files — this is primarily a frontend project
- Pure CSS 3D transforms (no WebGL or Three.js)
- HTML5 + CSS3 + vanilla JavaScript (or lightweight framework)
- All artwork images can use placeholder images (e.g., solid color canvases with titles, or public domain art URLs)

### API Endpoints
- `GET /` — Museum homepage / entry hall
- `GET /rooms/:id` — Individual room view (can be client-side routing)
- `GET /artworks` — JSON list of all artworks
- `GET /artworks/:id` — Single artwork detail JSON

### Data Model
- **Room**: id, name, theme, description, background_color
- **Artwork**: id, room_id, title, artist, year, medium, description, image_url, position_in_room
- **Artist**: name, birth_year, death_year, nationality, biography

## Testable Deliverables
- Server starts on port 3000
- Homepage loads with valid HTML (DOCTYPE present)
- 3D room perspective is visible with CSS transforms
- At least 3 rooms are navigable
- Artworks display with title and artist information
- Detail view opens on artwork click
- Responsive layout works on mobile viewport
