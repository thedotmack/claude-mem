// The sample's stages: what a ready stage reads like, with no agent and no worker. A sample stage's text rides in
// its address (a `data:` URL the reader fetches like any file); its image is a file the page itself serves.

const BRIEF = `# Move embeddings into their own table

> "stop the write stalls, i don't care how"

The vector index now lives in its own table, so a write to the content table no longer waits on it. The remap job moved every existing row and has been idle since.

## Look at this first

![Write stalls per hour, before and after](sample-stage-evidence.svg)

| | Before | After |
| --- | --- | --- |
| Write stalls per hour | 126 | 8 |
| Slowest write | 4.1 s | 0.3 s |

1. Open pull request **#343**: the new table and the migration.
2. Then **#344**, which records the embedding job rate.

\`\`\`sql
SELECT count(*) FROM embedding_remap_queue; -- 0
\`\`\`

## Not verified

- The remap queue was read once. Nothing shows it stays empty under load.
- <b>Raw HTML</b> in a stage is shown as text, like this.
`

const DECK = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; font: 18px/1.4 system-ui, sans-serif; color: #2c2620; background: #f6f1ea; }
  section { display: none; box-sizing: border-box; height: 100%; padding: 8vmin; flex-direction: column; justify-content: center; gap: 1rem; }
  section.on { display: flex; }
  h1 { margin: 0; font-size: 1.8rem; } p { margin: 0; max-width: 40rem; }
  footer { position: fixed; right: 1rem; bottom: .75rem; font-size: .8rem; color: #6b6257; }
</style></head>
<body>
<section class="on"><h1>"stop the write stalls"</h1><p>Sample deck. Click, or press the arrow keys.</p></section>
<section><h1>What was made</h1><p>The vector index moved to its own table, so writes no longer wait on it.</p></section>
<section><h1>What to decide</h1><p>Is one read of an empty remap queue enough to call it done?</p></section>
<footer id="at"></footer>
<script>
  const slides = [...document.querySelectorAll('section')]; let at = 0
  const show = (next) => { at = Math.max(0, Math.min(slides.length - 1, next)); slides.forEach((slide, index) => slide.classList.toggle('on', index === at)); document.getElementById('at').textContent = (at + 1) + ' / ' + slides.length }
  addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') show(at + 1); if (event.key === 'ArrowLeft') show(at - 1) })
  addEventListener('click', () => show(at === slides.length - 1 ? 0 : at + 1)); show(0)
</script>
</body></html>
`

const PLAIN = (label: string) => `# ${label}

A sample stage. On your own work this is the document your agent writes for the review.
`

/** The sample document for a format, as the address the reader fetches. */
export function sampleStageHref(format: { id: string; label: string; output: 'markdown' | 'html' }): string {
  const text = format.output === 'html' ? DECK : format.id === 'brief' ? BRIEF : PLAIN(format.label)
  return `data:${format.output === 'html' ? 'text/html' : 'text/markdown'};charset=utf-8,${encodeURIComponent(text)}`
}
