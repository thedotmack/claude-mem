import { sharedViewerFetch } from '../live/shared-viewer-session.ts'

/** Hide old data before a background tab or history entry can be shown again. A failed
 * identity probe keeps the page covered. A changed session discards the document and its drawers. */
export function installSharedViewerSession(owner: string, win: Window, doc: Document) {
  const root = doc.getElementById('root')
  if (!root) throw new Error('My Work requires an application root.')
  const status = doc.createElement('p')
  status.setAttribute('role', 'status')
  status.dataset.workSessionStatus = ''
  status.hidden = true
  status.textContent = 'Checking your account…'
  root.before(status)
  let ended = false
  let generation = 0
  let probe: AbortController | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const cover = () => {
    doc.documentElement.setAttribute('data-work-session-checking', '')
    status.hidden = false
  }
  const cancel = () => {
    generation++
    probe?.abort()
    probe = undefined
    clearTimeout(retry)
  }
  const endSession = () => {
    if (ended) return
    ended = true
    cancel()
    cover()
    win.location.replace('/work')
  }
  const nativeFetch = win.fetch.bind(win)
  win.fetch = sharedViewerFetch(owner, new URL(win.location.href), nativeFetch, endSession)
  const check = async (coverDuringCheck = true) => {
    if (ended || doc.hidden) return
    cancel()
    if (coverDuringCheck) cover()
    const current = generation
    probe = new AbortController()
    const timeout = setTimeout(() => { if (current === generation) probe?.abort() }, 10_000)
    try {
      const response = await nativeFetch('/api/work-view/session', {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-Work-Session': owner }, signal: probe.signal,
      })
      if (current !== generation || ended) return
      if ([401, 403, 409].includes(response.status)) { endSession(); return }
      if (!response.ok || (await response.json())?.ok !== true) throw new Error('Session unavailable')
      if (current !== generation || ended || doc.hidden) return
      doc.documentElement.removeAttribute('data-work-session-checking')
      status.hidden = true
    } catch {
      if (current === generation && !ended && !doc.hidden) {
        status.textContent = 'Waiting to reconnect…'
        retry = setTimeout(() => { void check(coverDuringCheck) }, 5_000)
      }
    } finally {
      clearTimeout(timeout)
      if (current === generation) probe = undefined
    }
  }
  const hide = () => { cancel(); cover() }
  doc.addEventListener('visibilitychange', () => doc.hidden ? hide() : void check())
  win.addEventListener('pagehide', hide)
  win.addEventListener('pageshow', event => { if (event.persisted) void check() })
  win.addEventListener('focus', () => { void check() })
  win.addEventListener('online', () => { void check() })
  win.addEventListener('cmem:session-ended', endSession)
  win.addEventListener('cmem:session-check', () => { if (!probe && !ended) void check(false) })
  // An open event stream carries the cookie from when it was opened. Ask with the
  // current cookie while a tab stays visible across a sign-out in another tab.
  setInterval(() => { if (!probe && !ended && !doc.hidden) void check(false) }, 60_000)
}
