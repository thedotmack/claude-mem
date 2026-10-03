---
name: wowerpoint
description: Turn one document into a kawaii NotebookLM slide deck. Use for "wowerpoint this", "make a deck about <file>", "turn this report into slides", or any request to render a single document as narrative slides.
---

# Wowerpoint

One doc in, one NotebookLM slide deck started. Slide-deck only — videos and podcasts from the same engine are noticeably worse and out of scope; refer the user to the `notebooklm` CLI directly if they want those.

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

### 3. Create the notebook

```bash
NOTEBOOK_ID=$(notebooklm create "<title>" --json | jq -r .notebook.id)
```

Title: H1 of the source doc, or its filename stem; append a date for dated work.

### 4. Add the source

```bash
SOURCE_ID=$(notebooklm source add "<doc-path>" --notebook "$NOTEBOOK_ID" --json | jq -r .source.id)
```

The JSON envelope keys are `create` → `.notebook.id` and `source add` → `.source.id`. A wrong key produces an empty string and a silent downstream failure.

### 5. Wait for the source to be ready

```bash
notebooklm source wait <SOURCE_ID> -n <NOTEBOOK_ID> --timeout 600
```

### 6. Start generation

```bash
notebooklm generate slide-deck "<PROMPT>" --format detailed --length default --notebook <NOTEBOOK_ID> --json --retry 2
```

### 7. Print the notebook URL and end the turn

After starting generation, print:

```text
https://notebooklm.google.com/notebook/<NOTEBOOK_ID>
```

Then end the turn.

## Output path

Adjacent to the source, parallel filename:

```text
<source-dir>/<source-stem>-slides.pdf
```

If the source isn't somewhere that makes sense as an output location, default to `reports/<stem>-slides.pdf`.

## PDF on explicit request

Only if the user later explicitly asks for the PDF, use the output path above:

```bash
notebooklm artifact list -n <NOTEBOOK_ID>
notebooklm artifact wait <artifact_id> -n <NOTEBOOK_ID> --timeout 1800
notebooklm download slide-deck "<OUTPUT_PATH>" -a <artifact_id> -n <NOTEBOOK_ID>
```

The deck may still be generating, so always wait on the artifact before downloading.

## The prompt

One sentence. Default:

```text
Use kawaii characters to tell the story of <subject>. Keep it warm and clear.
```

Replace `<subject>` with a one-phrase description from the source doc's H1 or the user's framing. If the user supplies their own prompt, pass it through verbatim — don't expand it.

## Failure modes

- **`pip: command not found`** — modern macOS doesn't ship pip on PATH. Use `uv tool install`.
- **`Playwright not installed`** — install `notebooklm-py` with `--with playwright`, then `playwright install chromium`.
- **`Run 'notebooklm login' to authenticate`** — only the user can complete OAuth.
- **Rate-limit (`GENERATION_FAILED` or "No result found for RPC ID")** — `--retry 2` handles transients. If it still fails, report the error and end the turn; retry or use the web UI only on a later user request.
- **Source upload denied for sensitive docs** — confirm before adding sources containing credentials, customer data, or unreleased product info. NotebookLM is a Google service.
- **`--length long` does not exist** — only `default|short`. If the user asks for "long slides," use `default` and explain.
- **No `--style` flag** — kawaii lives in the prompt text.

## Operational tips

- **Rerun cheaply** — once the notebook + source exist, regenerating with a different prompt only repeats generation. Reuse `NOTEBOOK_ID` and `SOURCE_ID`.
- **Web UI fallback** — if the user later reports generation is rate-limited for more than 30 minutes, open the notebook URL and trigger generation in the UI. Download a PDF only if they explicitly request it.
