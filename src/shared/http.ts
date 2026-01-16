/**
 * HTTP utilities with safe timeouts for local worker requests.
 *
 * Windows: avoid AbortController-based timeouts due to Bun cleanup issues.
 * Non-Windows: abort the request to prevent hung sockets.
 */

function fetchWithTimeoutNoAbort(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);

    fetch(url, options).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const isWindows = process.platform === 'win32';
  if (isWindows || options.signal) {
    return fetchWithTimeoutNoAbort(url, options, timeoutMs);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
