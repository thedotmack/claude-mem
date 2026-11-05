// Parse one `data:` payload from the work-view event stream.
//
// The stream is read in EventSource listeners, which run outside React's error
// boundaries: a throw there escapes the handler instead of being skipped. Every
// frame the worker writes is a JSON object, but a proxy that rewrites the
// stream, or a future producer, can send something else. Such a frame is
// skipped with a console warning that names only its event type (the body can
// hold the user's prompts), matching the viewer's useSSE handling (#5364).
// `null` means "skip this frame".
export function parseSseFrame(eventType: string, raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[work-view] Ignoring a ${eventType} frame that is not JSON`)
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[work-view] Ignoring a ${eventType} frame that is not a JSON object`)
    return null
  }
  return parsed as Record<string, unknown>
}
