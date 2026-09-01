# Project site

Static landing page for Claude-Mem, deployed to GitHub Pages at
**https://thedotmack.github.io/claude-mem/**.

## What's here

| File | Purpose |
|---|---|
| `index.html` | The whole page — self-contained, one file, embedded CSS + a few lines of JS |
| `assets/` | Brand logo + logomark (`.webp`), copied from `docs/public/` |

No build step, no dependencies, no framework. The only external request is Google
Fonts (Space Grotesk + Bricolage Grotesque + JetBrains Mono) — the same faces
cmem.ai uses. Every face has a system fallback.

## Design

The palette and type are lifted from the design tokens on
[cmem.ai](https://cmem.ai/) so the open-source landing page and the commercial
site read as one product:

- Background `#0d0a08`, text `#fef6ed`, brand orange `#fd6500`
- Headings: Space Grotesk 600–700 · Body: Bricolage Grotesque · Mono: JetBrains Mono
- Rounded cards (16–24px), warm-black surfaces, orange glow accents

## Local preview

```bash
cd site
python3 -m http.server 8899
# open http://localhost:8899
```

## Deploy

`.github/workflows/pages.yml` publishes this folder on every push to `main` that
touches `site/**`. It uses the official GitHub Pages Actions
(`upload-pages-artifact` + `deploy-pages`), so **Settings → Pages → Build and
deployment → Source** must be set to **GitHub Actions** once.

## Content note

Stats and the recall/terminal examples are illustrative and mirror the figures
published on cmem.ai. Community quotes are labelled composites for layout — swap
for real, attributed testimonials before relying on them.
