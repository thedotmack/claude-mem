
export function isAbortError(error: unknown): boolean {
  if (error === null || error === undefined) {
    return false;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  if (typeof error === 'object' && 'name' in error) {
    return (error as { name: unknown }).name === 'AbortError';
  }

  return false;
}
