---
id: "16-kanban-board"
title: "Kanban Board"
category: fullstack
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "homepage_loads"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
  - name: "create_board"
    command: "curl -s -X POST http://localhost:3000/boards -H 'Content-Type: application/json' -d '{\"name\":\"Project Alpha\"}'"
    expected: "contains:board"
  - name: "create_card"
    command: "curl -s -X POST http://localhost:3000/cards -H 'Content-Type: application/json' -d '{\"board_id\":1,\"title\":\"Fix bug\",\"column\":\"todo\"}'"
    expected: "contains:card"
---

# Kanban Board

Build a full-stack Kanban board application with drag-and-drop card management, multiple boards, and persistent data.

## Requirements

### Core Features
1. **Multiple Boards**: Create, rename, and delete boards
2. **Columns**: Each board has configurable columns (default: To Do, In Progress, Done). Add/rename/delete columns.
3. **Cards**: Create cards with title, description, color label, and due date. Edit and delete cards.
4. **Drag and Drop**: Move cards between columns and reorder within a column via drag-and-drop
5. **Persistence**: All data survives page refresh (stored server-side)
6. **Card Details Modal**: Click a card to open a detailed view with full description, due date editing, and label selection

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express
- SQLite for persistence
- Frontend: HTML/CSS/JS with drag-and-drop (HTML5 Drag and Drop API or a library like SortableJS)
- Responsive layout: columns scroll horizontally on small screens

### API Endpoints
- `GET /` — Board selection page / main app
- `GET /boards` — List all boards
- `POST /boards` — Create a board
- `PUT /boards/:id` — Update board name
- `DELETE /boards/:id` — Delete board and all its cards
- `GET /boards/:id` — Get board with columns and cards
- `POST /columns` — Add column to a board
- `PUT /columns/:id` — Rename/reorder column
- `DELETE /columns/:id` — Delete column (and its cards, or move them)
- `GET /cards` — List cards (filterable by board_id, column)
- `POST /cards` — Create a card
- `PUT /cards/:id` — Update card (title, description, column, position, label, due_date)
- `DELETE /cards/:id` — Delete a card
- `PUT /cards/:id/move` — Move card to different column/position

### Data Model
- **Board**: id, name, created_at
- **Column**: id, board_id, name, position
- **Card**: id, column_id, title, description, color_label, due_date, position, created_at, updated_at

### UI Requirements
- Clean, modern design with clear visual separation between columns
- Cards show title, color label indicator, and due date
- Drag handle or entire card is draggable
- Visual feedback during drag (placeholder, shadow)
- Smooth animations on card movement

## Testable Deliverables
- Server starts on port 3000
- Boards can be created and listed
- Cards can be created in specific columns
- Cards can be moved between columns via API
- Data persists across page refreshes
- Drag-and-drop works in the browser
