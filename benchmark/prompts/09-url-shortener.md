---
id: "09-url-shortener"
title: "URL Shortener API"
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
  - name: "shorten_url"
    command: "curl -s -X POST http://localhost:3000/shorten -H 'Content-Type: application/json' -d '{\"url\":\"https://example.com\"}'"
    expected: "contains:alias"
  - name: "get_stats"
    command: "curl -s http://localhost:3000/stats/test"
    expected: "contains:count"
---

# URL Shortener API

Build a URL shortener REST API service. Users can submit long URLs and receive short aliases. Visiting the short alias redirects to the original URL. Stats endpoint tracks visit counts.

## Requirements

### Core Features
1. **Shorten URL**: Accept a long URL and return a short alias (auto-generated or custom)
2. **Redirect**: Visiting `GET /:alias` redirects (HTTP 302) to the original URL
3. **Statistics**: Track visit counts per alias, including total visits and visits over time
4. **Custom Aliases**: Optionally allow users to specify a custom alias (validate uniqueness)
5. **Expiration**: Optional TTL for short URLs (default: never expires)

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express or similar
- SQLite or in-memory storage
- Short aliases: 6-8 alphanumeric characters, URL-safe
- Rate limiting on the shorten endpoint (e.g., 100 requests per minute per IP)

### API Endpoints
- `GET /` — Health check / API info page
- `POST /shorten` — Create short URL
  - Body: `{ "url": "https://...", "custom_alias": "optional", "ttl_seconds": 0 }`
  - Response: `{ "alias": "abc123", "short_url": "http://localhost:3000/abc123", "original_url": "https://..." }`
- `GET /:alias` — Redirect to original URL (HTTP 302)
- `GET /stats/:alias` — Get visit statistics
  - Response: `{ "alias": "abc123", "original_url": "https://...", "count": 42, "created_at": "...", "last_visited": "..." }`

### Data Model
- **ShortURL**: id, alias (unique), original_url, created_at, expires_at, visit_count
- **Visit**: id, short_url_id, visited_at, ip_address, user_agent

### Error Handling
- Invalid URL format: 400 with descriptive message
- Alias already taken: 409 Conflict
- Alias not found: 404
- Expired alias: 410 Gone

## Testable Deliverables
- Server starts on port 3000
- POST /shorten with a valid URL returns an alias
- GET /:alias redirects to the original URL
- GET /stats/:alias returns visit count
- Custom alias works when provided and available
- Duplicate custom alias returns 409
