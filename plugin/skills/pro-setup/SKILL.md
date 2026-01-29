---
name: pro-setup
description: This skill should be used when the user wants to connect their Claude-Mem installation to their Pro account, or when they have a setup token from the dashboard. Use this skill when the user mentions Pro setup, cloud sync, or provides a setup token starting with cm_pro_.
version: 1.0.0
---

# Claude-Mem Pro Setup

You are helping the user configure Claude-Mem Pro cloud sync.

## Prerequisites

The user needs:
1. A Claude-Mem Pro subscription (purchase at https://claude-mem.com/pricing)
2. A setup token from the Claude-Mem Pro dashboard

## Setup Process

The setup token format is: `cm_pro_<32-character-hex-string>`

### Step 1: Validate Token

If the user provided a token as $ARGUMENTS, use it. Otherwise, ask them to provide it.

Once you have the token, validate it by calling the worker API:

```bash
curl -X POST http://localhost:37777/api/pro/setup \
  -H "Content-Type: application/json" \
  -d '{"setupToken": "<TOKEN_HERE>"}'
```

### Step 2: Verify Setup

If the setup succeeds, the API returns:
```json
{
  "success": true,
  "userId": "...",
  "planTier": "pro",
  "features": ["cloud_sync", "cross_device", "unlimited_storage"]
}
```

### Step 3: Confirm to User

Tell the user:
- Pro setup is complete
- Their memories will now sync to the cloud
- They can view their data at https://claude-mem.com/dashboard
- Cloud sync happens automatically with each observation/summary

## Troubleshooting

If setup fails:
- **Invalid token**: Token may be expired or already used. Get a new one from the dashboard.
- **Network error**: Ensure you have internet access.
- **Worker not running**: Run `claude-mem start` to start the worker.

## Token Security

The setup token is stored securely in `~/.claude-mem/pro.json` and is only used for API authentication.
Do NOT share setup tokens or store them in version control.
