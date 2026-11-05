// Parse one `data:` payload from the work-view event stream.
//
// The stream is read in EventSource listeners, which run outside React's error
// boundaries: a throw there escapes the handler instead of being skipped. Every
// frame the worker writes is JSON, but a proxy that rewrites the stream, or a
// future non-JSON producer, can send a body that is not — so a frame that cannot
// be parsed is dropped rather than thrown. `null` means "ignore this frame".
export function parseSseFrame(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
