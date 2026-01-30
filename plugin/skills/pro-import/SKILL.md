---
name: pro-import
description: Import your memories from the cloud to your local machine. Use this when setting up a new device, restoring data, or recovering data after subscription ends. Works for active and recently-cancelled subscriptions.
version: 1.0.0
---

# Claude-Mem Pro Import

Import your cloud-synced memories to your local machine.

## When to Use

- Setting up Claude-Mem on a new device
- Restoring data after reinstalling
- Creating a local backup of your cloud data
- **Recovering your data after subscription ends** (grace period export)

## Prerequisites

1. A Claude-Mem Pro account (active or recently-cancelled)
2. Already configured with `/pro-setup`

## Import Process

### Step 1: Check Pro Status

First verify Pro is configured:

```bash
curl http://localhost:37777/api/pro/status
```

If not configured, run `/pro-setup` first.

### Step 2: Start Import

Trigger the cloud import:

```bash
curl -X POST http://localhost:37777/api/pro/import
```

### Step 3: Report Results

The import returns stats about what was imported:

```json
{
  "success": true,
  "imported": {
    "observations": 150,
    "summaries": 45,
    "prompts": 200
  },
  "cloudStats": {
    "observations": 150,
    "summaries": 45,
    "prompts": 200,
    "projects": ["project-a", "project-b"]
  },
  "subscriptionActive": true,
  "downgradeNotice": null
}
```

Tell the user:
- How many items were imported
- How many were skipped (already existed locally)
- That their memories are now available locally

### Step 4: Handle Downgrade (if applicable)

If `subscriptionActive` is `false` or `downgradeNotice` is present, the user's subscription has ended.
Tell them:
- Their data has been imported locally
- Cloud sync is no longer available
- They should run `/pro-disconnect` to reset to free mode
- After disconnect, future observations will use local Chroma storage

To disconnect:
```bash
curl -X POST http://localhost:37777/api/pro/disconnect
```

## Notes

- Import is additive - it won't delete existing local data
- Duplicates are automatically skipped based on ID or session+prompt_number
- Large imports may take a moment
- **Grace period**: Users with cancelled subscriptions can still export their data for data recovery
