declare module '@opencode-ai/sdk/client' {
  export interface OpencodeClientLike {
    session: {
      create(args: unknown): Promise<unknown>;
      prompt(args: unknown): Promise<unknown>;
    };
  }

  export function createOpencodeClient(config?: unknown): OpencodeClientLike;
}
