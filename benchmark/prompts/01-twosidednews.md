---
id: "01-twosidednews"
title: "Two-Sided News Aggregator"
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
  - name: "search_returns_articles"
    command: "curl -s http://localhost:3000/search?topic=climate"
    expected: "contains:article"
---

# Two-Sided News Aggregator

Build a news aggregation web application that shows two opposing viewpoints on any topic the user searches for.

## Requirements

### Core Features
1. **Topic Search**: User enters a topic in a search bar on the homepage
2. **Two-Column Layout**: Results display in two side-by-side columns representing opposing viewpoints (e.g., "For" vs "Against", "Left-leaning" vs "Right-leaning")
3. **Article Cards**: Each article displays:
   - Title
   - Source name
   - Summary paragraph (2-3 sentences)
   - Visual indicator of which "side" it represents
4. **Responsive Design**: Layout adapts from two columns on desktop to stacked on mobile

### Technical Requirements
- Serves on **port 3000**
- Node.js backend (Express or similar)
- Frontend can be plain HTML/CSS/JS or a lightweight framework
- Articles can be sourced from a mock data layer, RSS feeds, or a news API (mock data is acceptable for the benchmark)
- If using mock data, provide at least 10 articles per side for 3 different topics (climate, healthcare, technology regulation)

### API Endpoints
- `GET /` — Homepage with search bar
- `GET /search?topic=<query>` — Returns page with two columns of articles for the given topic

### Data Model
Each article should have at minimum:
- `title` (string)
- `source` (string)
- `summary` (string)
- `viewpoint` (string: one of the two opposing sides)
- `url` (string, can be placeholder)

## Testable Deliverables
- Server starts without errors on port 3000
- Homepage loads with a visible search input
- Searching a topic returns articles in a two-column layout
- Each article card displays title, source, and summary
- Layout is responsive (viewport under 768px stacks columns)
