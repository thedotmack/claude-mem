
export class AdapterRejectedInput extends Error {
  constructor(public readonly reason: string) {
    super(`adapter rejected input: ${reason}`);
    this.name = 'AdapterRejectedInput';
  }
}

export function isValidCwd(cwd: unknown): cwd is string {
  return typeof cwd === 'string' && cwd.length > 0;
}
