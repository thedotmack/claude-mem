// What the reader puts in the frame for an HTML stage. The stage is a document an agent wrote from conversation text,
// so it is treated as hostile: it may run its own inline script (a deck's arrow keys) and show images embedded in it,
// and it may ask nothing of any other address.

/** The sandbox an HTML stage runs in: its own scripts and nothing of the page's origin. */
export const STAGE_FRAME_SANDBOX = 'allow-scripts'

/**
 * The policy an HTML stage runs under. Evidence images are embedded as `data:` (stage-task.ts placeStageEvidence), so
 * nothing is loaded over the network: no image, script, style sheet, font, fetch, form or nested page.
 */
export const STAGE_FRAME_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${STAGE_FRAME_POLICY}">`
const attribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

/**
 * `html` with the policy as the first thing the browser reads after the doctype. A policy the document states itself,
 * before or after, can only narrow ours (a browser enforces every policy it meets), and `base-uri 'none'` is in force
 * before any `<base>` the document carries.
 */
export function withStagePolicy(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? ''
  return `${doctype}${POLICY_META}${html.slice(doctype.length)}`
}

/**
 * The `srcdoc` of the reader's frame: a wrapper the page wrote, holding the stage in a sandboxed frame of its own.
 * A content policy does not stop a document from navigating itself, so a stage framed directly could send what it
 * holds as the address of its next page. A frame's navigations are checked against the policy of the document that
 * holds it; the wrapper's allows no frame address at all, so the stage stays where it is.
 */
export function stageFrameDocument(html: string): string {
  return `<!doctype html><html><head>${POLICY_META}<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style></head>`
    + `<body><iframe sandbox="${STAGE_FRAME_SANDBOX}" srcdoc="${attribute(withStagePolicy(html))}"></iframe></body></html>`
}
