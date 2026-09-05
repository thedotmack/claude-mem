# Transcriber (NEURAFLOW)

Clone of the static web app published at https://bndrbots.github.io/transcriber/
(source: https://github.com/bndrbots/transcriber).

A single-file browser app for audio/video transcription and transcript analysis.
It is standalone — not part of the claude-mem plugin build, and nothing here is
referenced by `npm run build-and-sync`.

## Running it

No build step. Open `index.html` directly, or serve the directory:

```bash
npx serve transcriber
```

## What it does

- **File upload** — drag-and-drop or browse for audio/video (25 MB cap, enforced client-side).
- **Live capture** — records from the microphone via `MediaRecorder`, then transcribes on stop.
- **Transcription** — posts to OpenAI `/v1/audio/transcriptions`; selectable model
  (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-transcribe-diarize`).
- **Transcript editing** — per-word tokens with a right-click menu (edit, highlight, delete).
- **Analysis** — sends the transcript to the DeepSeek chat API for summarize / speaker
  breakdown / keywords / translate, plus a free-form prompt box.
- **Export** — copy to clipboard or download as `.txt`.

## Stack

Plain HTML/CSS/JS, no bundler. Three CDN dependencies loaded at runtime:
Tailwind (`cdn.tailwindcss.com`), Lucide icons (`unpkg.com/lucide`), and Inter
from Google Fonts.

## Caveats carried over from upstream

These are properties of the original app, preserved as-is by this clone:

- API keys are entered in the page and sent directly from the browser to OpenAI and
  DeepSeek. Any key pasted in is exposed to anything running in that page context,
  including the three CDN scripts. A backend proxy is the right shape for real use.
- Speaker labels are fabricated when the selected model doesn't return diarization —
  non-diarize responses get alternating `Speaker 1`/`Speaker 2` by sentence index, and
  the diarize path falls back to a random speaker number when `seg.speaker` is absent.
- The confidence metric is hardcoded to `97%`; it is not derived from the API response.
- The waveform is decorative — random bar heights, not real audio levels.
- DeepSeek responses are inserted with `innerHTML`, so model output is rendered as HTML.
