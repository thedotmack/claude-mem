---
id: "02-mealprep-planner"
title: "Meal Prep Planner"
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
  - name: "register_user"
    command: "curl -s -X POST http://localhost:3000/register -H 'Content-Type: application/json' -d '{\"username\":\"test\",\"password\":\"test123\"}'"
    expected: "contains:success"
  - name: "get_plans"
    command: "curl -s http://localhost:3000/plans"
    expected: "contains:plan"
---

# Meal Prep Planner

Build a meal planning web application where users can create accounts, build weekly meal plans, and export grocery lists.

## Requirements

### Core Features
1. **User Accounts**: Register and login with username/password
2. **Meal Plan Builder**: Create weekly meal plans by assigning meals to days and meal slots (breakfast, lunch, dinner, snack)
3. **Recipe Library**: Browse and search a library of recipes; each recipe has ingredients and instructions
4. **Grocery List Export**: Generate a consolidated grocery list from a meal plan, combining duplicate ingredients and summing quantities
5. **Save/Load Plans**: Persist meal plans to the user's account; load previous plans

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express or similar
- SQLite or in-memory storage for persistence
- Session-based or token-based authentication
- Frontend with forms for meal plan creation

### API Endpoints
- `POST /register` — Create account (returns success message)
- `POST /login` — Authenticate user
- `GET /plans` — List user's meal plans
- `POST /plans` — Create a new meal plan
- `GET /plans/:id` — Get a specific plan
- `GET /plans/:id/grocery-list` — Export grocery list for a plan
- `GET /recipes` — List available recipes
- `GET /recipes/search?q=<query>` — Search recipes

### Data Model
- **User**: id, username, password_hash
- **MealPlan**: id, user_id, name, week_start_date
- **MealSlot**: id, plan_id, day_of_week, meal_type (breakfast/lunch/dinner/snack), recipe_id
- **Recipe**: id, name, description, instructions, prep_time_minutes
- **Ingredient**: id, recipe_id, name, quantity, unit

Seed the database with at least 15 recipes across different categories.

## Testable Deliverables
- Server starts on port 3000
- User can register and login
- Meal plans can be created and retrieved
- Grocery list is generated from a meal plan with correct ingredient aggregation
- Recipe search returns relevant results
