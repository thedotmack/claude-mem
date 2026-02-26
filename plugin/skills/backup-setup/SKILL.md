---
name: backup-setup
description: Set up or restore cloud backup for claude-mem database using Litestream to Google Cloud Storage. Use when user says "set up backup", "configure cloud backup", "restore my memories", or "I'm on a new machine".
disable-model-invocation: true
allowed-tools: Bash, Read, Write
argument-hint: [setup|restore|status]
---

# Cloud Backup Setup (GCS)

Interactive wizard to configure Litestream cloud backup for `~/.claude-mem/claude-mem.db` to Google Cloud Storage.

## Routing

Based on `$ARGUMENTS`:
- `setup` or empty → go to **Setup Flow**
- `restore` → go to **Restore Flow (New Machine)**
- `status` → run `curl -s http://127.0.0.1:37777/api/backup/status` and show the result

## Overview

This skill guides the user through setting up automatic cloud backup to GCS. Once configured, every change to the memory database is streamed to Google Cloud Storage within 1 second. On a new machine, a single restore command brings back all memories.

## Setup Flow

Follow these steps IN ORDER. Use `AskUserQuestion` at each decision point.

### Step 1: Check Prerequisites

Ask the user:
1. Do you have a Google Cloud account?
2. Do you have `gcloud` CLI installed? (If not, guide: `brew install google-cloud-sdk` on Mac, or `curl https://sdk.cloud.google.com | bash` on Linux)
3. Are you logged in? (If not: `gcloud auth login`)

### Step 2: Collect Project Info

Ask the user for their **GCP Project ID**. They can find it with:
```bash
gcloud projects list
```

### Step 3: Create GCS Resources

Ask if they already have a bucket and service account key, or need to create them.

If they need to create them, provide these commands one by one (each as a separate copyable block, no line breaks with `\`):

**Set project:**
```bash
gcloud config set project PROJECT_ID
```

**Create bucket:**
```bash
gcloud storage buckets create gs://PROJECT_ID-claude-mem-backup --location=asia-east1 --uniform-bucket-level-access
```

**Create service account:**
```bash
gcloud iam service-accounts create claude-mem-backup --display-name="Claude-Mem Backup"
```

**Grant bucket permissions:**
```bash
gcloud storage buckets add-iam-policy-binding gs://PROJECT_ID-claude-mem-backup --member="serviceAccount:claude-mem-backup@PROJECT_ID.iam.gserviceaccount.com" --role="roles/storage.objectAdmin"
```

**Download key to claude-mem directory:**
```bash
gcloud iam service-accounts keys create ~/.claude-mem/gcs-backup-key.json --iam-account="claude-mem-backup@PROJECT_ID.iam.gserviceaccount.com"
```

Replace `PROJECT_ID` with the user's actual project ID in all commands.

If the user is running these on a different machine from where claude-mem is installed, remind them to transfer the key file:
```bash
scp ~/path/to/key.json user@claude-mem-machine:~/.claude-mem/gcs-backup-key.json
```

### Step 4: Verify Key File Exists

Before writing settings, confirm the key file is on this machine:
```bash
ls -la ~/.claude-mem/gcs-backup-key.json
```

If it doesn't exist, help the user get it onto this machine.

### Step 5: Write Settings

```bash
curl -X POST http://127.0.0.1:37777/api/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "CLAUDE_MEM_BACKUP_ENABLED": "true",
    "CLAUDE_MEM_BACKUP_PROVIDER": "gcs",
    "CLAUDE_MEM_BACKUP_BUCKET": "BUCKET_NAME",
    "CLAUDE_MEM_BACKUP_PATH": "claude-mem/backup",
    "CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH": "/home/USER/.claude-mem/gcs-backup-key.json"
  }'
```

IMPORTANT: Use the absolute path for `GCS_CREDENTIALS_PATH` (not `~`). Resolve it first with `echo ~/.claude-mem/gcs-backup-key.json`.

### Step 6: Restart and Verify

Restart the worker so Litestream starts:
```bash
curl -X POST http://127.0.0.1:37777/api/shutdown
```

Wait a few seconds for worker to restart, then check:
```bash
curl -s http://127.0.0.1:37777/api/backup/status
```

Confirm `running: true` and `error: null`.

If there's an error, common issues:
- Wrong key path → check absolute path
- Bucket doesn't exist → check bucket name
- Permission denied → re-run the `add-iam-policy-binding` command

### Step 7: Confirm Success

Tell the user:
- Backup is now active — every DB change streams to GCS within 1 second
- No action needed day-to-day; it's fully automatic
- To check status: `/claude-mem:backup-setup status`
- To restore on a new machine: `/claude-mem:backup-setup restore`

## Restore Flow (New Machine)

If the user asks about restoring (e.g., "I'm on a new machine", "how do I restore my memories"):

### Step R1: Get the credentials file onto this machine

Ask the user how they want to transfer the service account JSON key. Provide options:

**Option A — SCP from old machine:**
```bash
scp old-machine:~/.claude-mem/gcs-backup-key.json ~/.claude-mem/gcs-backup-key.json
```

**Option B — Download from GCP Console:**
1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
2. Select your project
3. Click the `claude-mem-backup` service account
4. Go to **KEYS** tab → **ADD KEY** → **Create new key** → **JSON** → **CREATE**
5. Move the downloaded file:
   ```bash
   mkdir -p ~/.claude-mem
   mv ~/Downloads/claude-mem-cloud-*.json ~/.claude-mem/gcs-backup-key.json
   ```

**Option C — Regenerate with gcloud CLI:**
```bash
gcloud iam service-accounts keys create ~/.claude-mem/gcs-backup-key.json --iam-account="claude-mem-backup@PROJECT_ID.iam.gserviceaccount.com"
```

### Step R2: Get bucket name

Ask the user for their GCS bucket name. It's usually `PROJECT_ID-claude-mem-backup`.

### Step R3: Write settings and restore

Write backup settings (use absolute path for key file):
```bash
curl -X POST http://127.0.0.1:37777/api/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "CLAUDE_MEM_BACKUP_ENABLED": "true",
    "CLAUDE_MEM_BACKUP_PROVIDER": "gcs",
    "CLAUDE_MEM_BACKUP_BUCKET": "BUCKET_NAME",
    "CLAUDE_MEM_BACKUP_PATH": "claude-mem/backup",
    "CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH": "/absolute/path/to/gcs-backup-key.json"
  }'
```

Then restore:
```bash
curl -X POST http://127.0.0.1:37777/api/backup/restore
```

### Step R4: Restart and verify

Restart worker to load the restored database:
```bash
curl -X POST http://127.0.0.1:37777/api/shutdown
```

After restart, verify:
```bash
curl -s http://127.0.0.1:37777/api/stats
```

Check observation count matches what the user expects. Backup auto-resumes replicating from this point.

## Disable Backup

If the user wants to turn off backup:

```bash
curl -X POST http://127.0.0.1:37777/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"CLAUDE_MEM_BACKUP_ENABLED": "false"}'
```

Then restart the worker.
