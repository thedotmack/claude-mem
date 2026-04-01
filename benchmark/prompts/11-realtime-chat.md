---
id: "11-realtime-chat"
title: "Real-Time Chat Server"
category: api
timeout_hint: "4h"
industry_baseline:
  source: none
  reference_cost_usd: null
  reference_duration_seconds: null
  reference_architecture: null
smoke_tests:
  - name: "health_check"
    command: "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000"
    expected: "status:200"
---

# Real-Time Chat Server

Build a real-time chat server with WebSocket support. Users can join rooms, send messages, and see message history. Includes a simple web client for testing.

## Requirements

### Core Features
1. **WebSocket Connection**: Clients connect via WebSocket to send and receive messages in real-time
2. **Chat Rooms**: Users can create and join named rooms. Messages are scoped to rooms.
3. **User Identity**: Users set a display name on connection. Names must be unique per room.
4. **Message History**: Messages persist and new users can see the last 50 messages when joining a room
5. **Typing Indicators**: Broadcast "user is typing" events to other users in the room
6. **User List**: Each room shows currently connected users
7. **System Messages**: Announce when users join or leave a room

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express for HTTP + ws/Socket.io for WebSocket
- SQLite or in-memory storage for message persistence
- Simple HTML/JS client served at the root URL for testing
- Handle disconnections gracefully (remove user from room, broadcast leave event)

### API Endpoints (HTTP)
- `GET /` — Chat client HTML page
- `GET /health` — Health check endpoint
- `GET /rooms` — List active rooms with user counts
- `GET /rooms/:name/history` — Get recent messages for a room

### WebSocket Protocol
```json
// Client → Server
{ "type": "join", "room": "general", "username": "alice" }
{ "type": "message", "room": "general", "text": "Hello everyone!" }
{ "type": "typing", "room": "general" }
{ "type": "leave", "room": "general" }

// Server → Client
{ "type": "message", "room": "general", "username": "alice", "text": "Hello!", "timestamp": "..." }
{ "type": "system", "room": "general", "text": "alice joined the room" }
{ "type": "typing", "room": "general", "username": "bob" }
{ "type": "users", "room": "general", "users": ["alice", "bob"] }
{ "type": "history", "room": "general", "messages": [...] }
```

### Data Model
- **Room**: name, created_at
- **Message**: id, room_name, username, text, timestamp
- **Connection**: socket_id, username, room_name

## Testable Deliverables
- Server starts on port 3000
- Health endpoint returns 200
- Web client loads and allows joining a room
- Messages sent by one client appear for other clients in the same room
- Message history is returned when joining a room
- User list updates when users join/leave
