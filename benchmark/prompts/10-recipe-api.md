---
id: "10-recipe-api"
title: "Recipe CRUD API"
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
  - name: "create_recipe"
    command: "curl -s -X POST http://localhost:3000/recipes -H 'Content-Type: application/json' -d '{\"title\":\"Pasta\",\"ingredients\":[\"noodles\",\"sauce\"],\"instructions\":\"Boil and mix\"}'"
    expected: "contains:id"
  - name: "search_recipes"
    command: "curl -s 'http://localhost:3000/recipes/search?q=pasta'"
    expected: "contains:recipe"
---

# Recipe CRUD API

Build a RESTful API for managing recipes. Supports full CRUD operations, search, tagging, and filtering by category or ingredient.

## Requirements

### Core Features
1. **Create Recipe**: Add a recipe with title, description, ingredients, instructions, prep time, cook time, servings, and tags
2. **Read Recipes**: Get a single recipe by ID or list all recipes with pagination
3. **Update Recipe**: Edit any field of an existing recipe
4. **Delete Recipe**: Remove a recipe
5. **Search**: Full-text search across title, description, and ingredients
6. **Filter by Tag/Category**: Filter recipes by tags (e.g., "vegetarian", "quick", "Italian")
7. **Ingredient Search**: Find recipes that contain specific ingredients

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express or similar
- SQLite for persistence
- Input validation on all endpoints
- Pagination with `?page=1&limit=20` parameters

### API Endpoints
- `GET /` — API info / health check
- `POST /recipes` — Create a recipe
- `GET /recipes` — List recipes (paginated)
- `GET /recipes/:id` — Get a single recipe
- `PUT /recipes/:id` — Update a recipe
- `DELETE /recipes/:id` — Delete a recipe
- `GET /recipes/search?q=<query>` — Search recipes
- `GET /recipes/tags` — List all tags
- `GET /recipes?tag=<tag>` — Filter by tag
- `GET /recipes?ingredient=<ingredient>` — Filter by ingredient

### Data Model
- **Recipe**: id, title, description, ingredients (JSON array), instructions (text), prep_time_minutes, cook_time_minutes, servings, created_at, updated_at
- **Tag**: id, name
- **RecipeTag**: recipe_id, tag_id

### Seed Data
Pre-populate the database with at least 10 recipes across different categories (Italian, Mexican, Asian, desserts, etc.) with realistic ingredients and instructions.

### Error Handling
- Missing required fields: 400 with field-specific messages
- Recipe not found: 404
- Invalid ID format: 400

## Testable Deliverables
- Server starts on port 3000
- Recipes can be created, read, updated, and deleted
- Search returns relevant results based on title or ingredients
- Tag filtering works correctly
- Pagination returns correct page sizes and totals
- Seed data is present on first start
