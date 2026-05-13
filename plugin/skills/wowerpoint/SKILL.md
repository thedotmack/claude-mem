---
name: wowerpoint
description: Turn one document into a kawaii NotebookLM slide-deck PDF. Use for "wowerpoint this", "make a deck about <file>", "turn this report into slides", or any request to render a single document as shareable narrative slides.
---

# Wowerpoint

One doc in, one PDF out. Slide-deck only — videos and podcasts from the same engine are noticeably worse and out of scope; refer the user to the `notebooklm` CLI directly if they want those.

## Triggers

- "Wowerpoint <file>"
- "Make a slide deck about <file>"
- "Turn this report into slides"
- "Kawaii-deck this"

## Setup (one-time per machine)

If `notebooklm auth check` returns 0 and `command -v jq` resolves, skip.

```bash
uv tool install --with playwright --force notebooklm-py
$(uv tool dir)/notebooklm-py/bin/playwright install chromium
```

`jq` is required by the workflow's JSON parsing; install if missing (`brew install jq` on macOS, or your distro's package manager).

Then the user authenticates interactively — do not script. Tell them to type `! notebooklm login` so the OAuth ENTER lands in their terminal.

## Workflow

### 1. The source doc

You need exactly one source doc. If it doesn't exist or is too thin to carry a deck, **write it first** — use mem-search and sequential thinking to make it comprehensive (long-form, narrative, several thousand words is normal). Do not paper over a weak source by adding more sources.

### 2. Auth pre-flight

```bash
notebooklm auth check 2>&1 | tail -5
```

Exit 1 with `Run 'notebooklm login' to authenticate.` = halt and tell the user.

### 3. Create notebook, add the source

```bash
NOTEBOOK_ID=$(notebooklm create "<title>" --json | jq -r .notebook.id)
SOURCE_ID=$(notebooklm source add "<doc-path>" --notebook "$NOTEBOOK_ID" --json | jq -r .source.id)
```

Title: H1 of the source doc, or its filename stem; append a date for dated work.

JSON envelope keys differ — `create` → `.notebook.id`, `source add` → `.source.id`, `generate` → `.task_id`. Wrong key = empty string = silent downstream failure.

### 4. Spawn the subagent

Generation takes ~10 minutes; never block on it. Use the template below with `run_in_background: true`.

### 5. End your turn

Print the notebook URL so the user can watch live:

```text
https://notebooklm.google.com/notebook/<NOTEBOOK_ID>
```

The subagent's completion notification fires when the file is on disk.

## Output path

Adjacent to the source, parallel filename:

```text
<source-dir>/<source-stem>-slides.pdf
```

If the source isn't somewhere that makes sense as an output location, default to `reports/<stem>-slides.pdf`.

## Share link (WOWerpoint Server)

After the PDF lands on disk, the subagent also POSTs it to the WOWerpoint Server, which converts the 16:9 deck into a 9:16 mobile twin and returns a share URL. The share URL is the primary deliverable to the user; the PDF on disk is the backup.

Required env (exported in the user's shell — the subagent inherits the parent's environment, so plain `export` is enough; no dotenv loader runs):

```bash
WOWERPOINT_API_BASE=https://wowerpoint-api.<subdomain>.workers.dev
WOWERPOINT_VIEWER_BASE=https://wowerpoint-viewer.<subdomain>.workers.dev
WOWERPOINT_UPLOAD_TOKEN=<token>
```

If any var is missing, skip the share-link step and just hand the PDF over.

Upload pattern (run AFTER the subagent confirms the PDF exists on disk). Capture the full response so empty `id` and `error` payloads are handled — `jq -r '.id'` returns the literal string `null` on a missing key, so always pipe through `.id // empty`:

```bash
if [ -n "$WOWERPOINT_API_BASE" ] && [ -n "$WOWERPOINT_UPLOAD_TOKEN" ] && [ -n "$WOWERPOINT_VIEWER_BASE" ]; then
  UPLOAD_JSON=$(curl -sS --connect-timeout 10 --max-time 30 -X POST "$WOWERPOINT_API_BASE/api/decks" \
    -H "Authorization: Bearer $WOWERPOINT_UPLOAD_TOKEN" \
    -F "file=@<OUTPUT_PATH>" \
    -F "title=<TITLE>")
  DECK_ID=$(printf '%s' "$UPLOAD_JSON" | jq -r '.id // empty')
  API_ERROR=$(printf '%s' "$UPLOAD_JSON" | jq -r '.error // empty')
  if [ -n "$API_ERROR" ] || [ -z "$DECK_ID" ]; then
    echo "WOWerpoint upload warning: ${API_ERROR:-missing id}"
  else
    echo "Share URL: $WOWERPOINT_VIEWER_BASE/d/$DECK_ID"
  fi
fi
```

The returned `id` is a kebab-case slug derived from the title with a random creature suffix (e.g. `tokenrouter-quest-hawk`, or `velvet-comet-tiger` if the title is empty or non-ASCII). The share URL is:

```text
$WOWERPOINT_VIEWER_BASE/d/<id>
```

It works immediately (shows a "still converting…" page that auto-reloads when ready). Conversion takes ~1–2 min per slide. Print the share URL in your final response.

## The prompt

One sentence. Default:

```text
Use kawaii characters to tell the story of <subject>. Keep it warm and clear.
```

Replace `<subject>` with a one-phrase description from the source doc's H1 or the user's framing. If the user supplies their own prompt, pass it through verbatim — don't expand it.

## Subagent template (copy-paste, parameterize)

```text
You're handling NotebookLM slide-deck generation. Work in `<repo-absolute-path>`.

Context:
- The `notebooklm` CLI is installed and authenticated (parent verified with `notebooklm auth check`).
- A notebook and source already exist.

Inputs:
- Notebook ID: `<NOTEBOOK_ID>`
- Source ID: `<SOURCE_ID>`
- Generation prompt: `<PROMPT>`
- Output path: `<OUTPUT_PATH>`
- Deck title: `<TITLE>` (the notebook title, used by the share-link step)

Steps:

1. Wait for source: `notebooklm source wait <SOURCE_ID> -n <NOTEBOOK_ID> --timeout 600`
   Exit 0 = ready, 1 = error, 2 = timeout. On timeout, run `notebooklm source list -n <NOTEBOOK_ID> --json` and report status.

2. Generate: `notebooklm generate slide-deck "<PROMPT>" --format detailed --length default --notebook <NOTEBOOK_ID> --json --retry 2`
   Parse `task_id` from the JSON (key is `task_id` at top level).
   On `GENERATION_FAILED` or "No result found for RPC ID": sleep 300, retry once, then give up.

3. Wait for artifact: `notebooklm artifact wait <task_id> -n <NOTEBOOK_ID> --timeout 1800`

4. Download: `notebooklm download slide-deck <OUTPUT_PATH> -a <task_id> -n <NOTEBOOK_ID>`

5. Verify: `ls -la <OUTPUT_PATH>` confirms the file exists.

6. Upload to WOWerpoint Server for a mobile share link. Skip silently if any of `WOWERPOINT_API_BASE`, `WOWERPOINT_UPLOAD_TOKEN`, or `WOWERPOINT_VIEWER_BASE` is unset. Otherwise:

   ```bash
   if [ -n "$WOWERPOINT_API_BASE" ] && [ -n "$WOWERPOINT_UPLOAD_TOKEN" ] && [ -n "$WOWERPOINT_VIEWER_BASE" ]; then
     UPLOAD_JSON=$(curl -sS --connect-timeout 10 --max-time 30 -X POST "$WOWERPOINT_API_BASE/api/decks" \
       -H "Authorization: Bearer $WOWERPOINT_UPLOAD_TOKEN" \
       -F "file=@<OUTPUT_PATH>" \
       -F "title=<TITLE>")
     DECK_ID=$(printf '%s' "$UPLOAD_JSON" | jq -r '.id // empty')
     API_ERROR=$(printf '%s' "$UPLOAD_JSON" | jq -r '.error // empty')
     if [ -n "$API_ERROR" ] || [ -z "$DECK_ID" ]; then
       echo "WOWerpoint upload warning: ${API_ERROR:-missing id}"
     else
       echo "Share URL: $WOWERPOINT_VIEWER_BASE/d/$DECK_ID"
     fi
   fi
   ```

   On warning, the PDF on disk is still a valid deliverable — do not retry the upload.

Report briefly (under 200 words):
- Final artifact ID
- Time per phase (source wait, generation, render wait, download)
- Output file path + size
- Share URL (if produced)
- Any retries or warnings
- Exact error message if any step failed

Do NOT poll status manually. The `wait` commands handle backoff.
```

## Failure modes

- **`pip: command not found`** — modern macOS doesn't ship pip on PATH. Use `uv tool install`.
- **`Playwright not installed`** — install `notebooklm-py` with `--with playwright`, then `playwright install chromium`.
- **`Run 'notebooklm login' to authenticate`** — only the user can complete OAuth.
- **`task_id` parsed as empty string** — wrong JSON envelope key. `generate` returns `{"task_id": "..."}` at top level.
- **Rate-limit (`GENERATION_FAILED` or "No result found for RPC ID")** — `--retry 2` handles transients; persistent failure means wait 5–10 minutes or fall back to the web UI.
- **Source upload denied for sensitive docs** — confirm before adding sources containing credentials, customer data, or unreleased product info. NotebookLM is a Google service.
- **`--length long` does not exist** — only `default|short`. If the user asks for "long slides," use `default` and explain.
- **No `--style` flag** — kawaii lives in the prompt text.

## Operational tips

- **Rerun cheaply** — once the notebook + source exist, regenerating with a different prompt only repeats generation + download. Reuse `NOTEBOOK_ID` and `SOURCE_ID`.
- **Web UI fallback** — if generation is rate-limited >30 minutes, open the notebook URL, trigger generation in the UI, then `notebooklm artifact list -n <NOTEBOOK_ID>` and `download`.
