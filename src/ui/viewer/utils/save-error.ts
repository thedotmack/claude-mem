export const SAVE_ERROR_MAX_CHARS = 240;

export interface SaveErrorResponse {
  status: number;
  statusText: string;
  text: () => Promise<string>;
}

export async function describeSaveFailure(response: SaveErrorResponse): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(raw);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  let message: string | null = null;
  if (parsed !== null) {
    const err = typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : null;
    const msg = typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : null;
    const issues = parsed.issues;

    if (err !== null && msg !== null && err !== msg) {
      message = `${err}: ${msg}`;
    } else if (err !== null && Array.isArray(issues)) {
      const issueStr = (issues as Array<Record<string, unknown>>)
        .map(i => [
          Array.isArray(i.path) ? (i.path as unknown[]).join('.') : '',
          typeof i.message === 'string' ? i.message : ''
        ].filter(Boolean).join(': '))
        .join('; ');
      message = `${err}: ${issueStr}`;
    } else if (err !== null) {
      message = err;
    } else if (msg !== null) {
      message = msg;
    }
  }

  if (message === null) {
    if (response.statusText.length > 0) {
      message = response.statusText;
    } else if (response.status === 401) {
      message = 'Unauthorized';
    } else {
      message = `HTTP ${response.status}`;
    }
  }

  const ctrlChars = /[\s\u0000-\u001f\u007f]+/g;
  const normalize = (s: string) => s.replace(ctrlChars, ' ').trim();
  let normalized = normalize(message);

  if (normalized.length === 0) {
    if (response.statusText.length > 0) {
      normalized = normalize(response.statusText);
    }
    if (normalized.length === 0) {
      normalized = response.status === 401 ? 'Unauthorized' : `HTTP ${response.status}`;
    }
  }

  if ([...normalized].length > SAVE_ERROR_MAX_CHARS) {
    normalized = [...normalized].slice(0, SAVE_ERROR_MAX_CHARS - 1).join('') + '\u2026';
  }

  console.error('Settings save failed:', response.status, raw);

  return `\u2717 Error: ${normalized}`;
}
