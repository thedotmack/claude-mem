---
id: "12-expense-tracker-api"
title: "Expense Tracker API"
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
  - name: "register_user"
    command: "curl -s -X POST http://localhost:3000/register -H 'Content-Type: application/json' -d '{\"email\":\"test@test.com\",\"password\":\"test123\"}'"
    expected: "contains:token"
  - name: "create_expense"
    command: "curl -s -X POST http://localhost:3000/expenses -H 'Content-Type: application/json' -H 'Authorization: Bearer test-token' -d '{\"amount\":42.50,\"category\":\"food\",\"description\":\"Lunch\"}'"
    expected: "contains:expense"
---

# Expense Tracker API

Build a REST API for tracking personal expenses with user authentication. Users register, log expenses by category, and retrieve spending summaries and aggregates.

## Requirements

### Core Features
1. **User Registration & Login**: Register with email/password, login returns a JWT token
2. **Expense CRUD**: Create, read, update, and delete expenses. Each expense has: amount, category, description, date.
3. **Categories**: Predefined categories (food, transport, housing, entertainment, utilities, healthcare, shopping, other) plus custom categories
4. **Spending Summary**: Aggregate spending by category, by month, and overall totals
5. **Budget Limits**: Set monthly budget limits per category; API warns when approaching or exceeding limits
6. **Date Range Queries**: Filter expenses by date range

### Technical Requirements
- Serves on **port 3000**
- Node.js backend with Express
- SQLite for persistence
- JWT-based authentication (all expense endpoints require valid token)
- Input validation on all endpoints
- Amounts stored as integers (cents) to avoid floating point issues

### API Endpoints
- `GET /` — API info / health
- `POST /register` — Register user (returns token)
- `POST /login` — Login (returns token)
- `GET /expenses` — List user's expenses (paginated, filterable by date range and category)
- `POST /expenses` — Create expense
- `PUT /expenses/:id` — Update expense
- `DELETE /expenses/:id` — Delete expense
- `GET /summary` — Spending summary
  - Query params: `?period=month&year=2024&month=3` or `?from=2024-01-01&to=2024-03-31`
  - Response: `{ "total": 1500.00, "by_category": { "food": 400, "transport": 200, ... }, "count": 45 }`
- `GET /budgets` — Get budget limits
- `PUT /budgets` — Set/update budget limits
  - Body: `{ "food": 500, "transport": 200 }`

### Data Model
- **User**: id, email (unique), password_hash, created_at
- **Expense**: id, user_id, amount_cents, category, description, expense_date, created_at, updated_at
- **Budget**: id, user_id, category, limit_cents, month, year

### Error Handling
- Invalid/missing auth token: 401
- Expense not found or not owned by user: 404
- Invalid input: 400 with field-specific messages
- Budget exceeded: 200 but response includes `"budget_warning": true`

## Testable Deliverables
- Server starts on port 3000
- User can register and receive a JWT token
- Authenticated user can create, list, update, and delete expenses
- Summary endpoint returns correct aggregates
- Budget warnings trigger when spending exceeds limits
- Unauthorized requests are rejected with 401
