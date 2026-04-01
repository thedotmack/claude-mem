---
id: "03-study-boss-fight"
title: "Study Boss Fight"
category: web
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
  - name: "create_deck"
    command: "curl -s -X POST http://localhost:3000/deck -H 'Content-Type: application/json' -d '{\"name\":\"Math\",\"cards\":[{\"question\":\"2+2\",\"answer\":\"4\"}]}'"
    expected: "contains:deck"
  - name: "start_battle"
    command: "curl -s -X POST http://localhost:3000/battle -H 'Content-Type: application/json' -d '{\"deck_id\":1}'"
    expected: "contains:boss"
---

# Study Boss Fight

Build a gamified flashcard web application where studying is framed as a boss fight. Users create flashcard decks, then "battle" a boss by answering questions correctly.

## Requirements

### Core Features
1. **Deck Management**: Create, edit, and delete flashcard decks. Each deck has a name and a list of cards (question/answer pairs).
2. **Boss Battle Mode**: Start a battle against a boss using a selected deck. The boss has a health bar. Each correct answer deals damage to the boss. Incorrect answers let the boss attack the player.
3. **Score Tracking**: Track player score, combo streaks, and damage dealt. Display a running score during battle.
4. **Boss Health System**: Boss health scales with deck size (e.g., 10 HP per card). Boss depletes as player answers correctly.
5. **Battle Results**: After all cards are answered (or player "dies"), show a results screen with stats: correct/incorrect, score, time taken.

### Technical Requirements
- Serves on **port 3000**
- Node.js backend
- In-memory or SQLite storage
- Frontend with interactive battle UI (health bars, animations encouraged but not required)
- Real-time feel: answer submission should immediately update the UI

### API Endpoints
- `GET /` — Homepage showing available decks and option to create new ones
- `POST /deck` — Create a new flashcard deck
- `GET /deck/:id` — Get deck details
- `PUT /deck/:id` — Edit a deck
- `DELETE /deck/:id` — Delete a deck
- `POST /battle` — Start a new battle with a given deck_id
- `POST /battle/:id/answer` — Submit an answer for the current card in battle
- `GET /battle/:id/status` — Get current battle state (boss HP, score, current card)

### Data Model
- **Deck**: id, name, created_at
- **Card**: id, deck_id, question, answer
- **Battle**: id, deck_id, boss_hp, player_hp, score, current_card_index, status (active/won/lost)

## Testable Deliverables
- Server starts on port 3000
- Decks can be created with cards
- Battles start and return boss state
- Answering correctly reduces boss HP
- Battle completes with results summary
