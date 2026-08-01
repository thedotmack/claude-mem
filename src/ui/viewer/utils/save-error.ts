export const SAVE_ERROR_MAX_CHARS = 240;
const SAVE_ERROR_MAX_BODY_BYTES = 64 * 1024;
const SAVE_ERROR_BODY_READ_TIMEOUT_MS = 1000;

export interface SaveErrorResponse {
  status: number;
  statusText: string;
  text: () => Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}

async function readResponseText(response: SaveErrorResponse): Promise<string> {
  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let raw = '';

  while (bytesRead < SAVE_ERROR_MAX_BODY_BYTES) {
    let timedOut = false;
    const timeout = new Promise<{ done: true; value: undefined }>(resolve => {
      setTimeout(() => {
        timedOut = true;
        resolve({ done: true, value: undefined });
      }, SAVE_ERROR_BODY_READ_TIMEOUT_MS);
    });
    const next = await Promise.race([reader.read(), timeout]);
    if (next.done || next.value === undefined) {
      if (timedOut) {
        void reader.cancel().catch(() => {});
      }
      break;
    }

    const remaining = SAVE_ERROR_MAX_BODY_BYTES - bytesRead;
    const chunk = next.value.subarray(0, remaining);
    bytesRead += chunk.byteLength;
    raw += decoder.decode(chunk, { stream: bytesRead < SAVE_ERROR_MAX_BODY_BYTES });
    if (chunk.byteLength < next.value.byteLength) {
      void reader.cancel().catch(() => {});
      break;
    }
  }

  return raw + decoder.decode();
}

export async function describeSaveFailure(response: SaveErrorResponse): Promise<string> {
  let raw = '';
  try {
    raw = await readResponseText(response);
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
      const issueStr = (issues as unknown[])
        .map(i => {
          if (i === null || typeof i !== 'object' || Array.isArray(i)) return '';
          const issue = i as Record<string, unknown>;
          return [
            Array.isArray(issue.path) ? (issue.path as unknown[]).join('.') : '',
            typeof issue.message === 'string' ? issue.message : ''
          ].filter(Boolean).join(': ');
        })
        .filter(Boolean)
        .join('; ');
      message = issueStr.length > 0 ? `${err}: ${issueStr}` : err;
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
