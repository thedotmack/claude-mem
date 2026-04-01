---
id: "04-password-vault"
title: "Password Vault"
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
  - name: "create_vault"
    command: "curl -s -X POST http://localhost:3000/vault -H 'Content-Type: application/json' -d '{\"master_password\":\"securepass123\"}'"
    expected: "contains:vault"
  - name: "add_entry"
    command: "curl -s -X POST http://localhost:3000/entry -H 'Content-Type: application/json' -d '{\"vault_id\":1,\"site\":\"example.com\",\"username\":\"user\",\"password\":\"pass123\"}'"
    expected: "contains:entry"
---

# Password Vault

Build a password manager web application with encrypted storage. Users create a vault protected by a master password, then add, edit, delete, and search credential entries.

## Requirements

### Core Features
1. **Vault Creation**: Create a new vault with a master password. The master password is used to derive an encryption key.
2. **Unlock/Lock**: Vault must be unlocked with the master password before entries are accessible. Lock the vault to require re-authentication.
3. **Entry CRUD**: Add, view, edit, and delete password entries. Each entry stores: site/service name, username, password, optional notes.
4. **Encrypted Storage**: Passwords must be encrypted at rest. Use AES-256 or similar symmetric encryption with the master-password-derived key.
5. **Search**: Search entries by site name or username.
6. **Password Generator**: Built-in random password generator with configurable length and character types.

### Technical Requirements
- Serves on **port 3000**
- Node.js backend
- SQLite for persistence
- Encryption using Node.js `crypto` module (AES-256-GCM recommended)
- Master password hashed with bcrypt or scrypt for vault authentication
- Frontend with forms and a clean table/list view of entries

### API Endpoints
- `GET /` — Homepage / vault selection
- `POST /vault` — Create a new vault
- `POST /vault/unlock` — Unlock vault with master password (returns session token)
- `POST /vault/lock` — Lock the vault
- `GET /entries` — List all entries (requires unlocked vault)
- `POST /entry` — Add a new entry
- `PUT /entry/:id` — Edit an entry
- `DELETE /entry/:id` — Delete an entry
- `GET /entries/search?q=<query>` — Search entries
- `GET /generate-password?length=16&uppercase=true&numbers=true&symbols=true` — Generate random password

### Data Model
- **Vault**: id, master_password_hash, salt, created_at
- **Entry**: id, vault_id, site_name, username, encrypted_password, iv, notes, created_at, updated_at

## Testable Deliverables
- Server starts on port 3000
- Vault can be created and unlocked
- Entries can be added with encrypted passwords
- Entries can be searched by site name
- Password generator returns passwords matching requested criteria
- Locking the vault prevents entry access without re-authentication
