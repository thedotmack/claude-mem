type HumanCopyProvider = ((input: unknown) => Promise<Record<string, unknown>>) & { isAvailable?: () => boolean; isOff?: () => boolean; getConfigKey?: () => string | null };
export function chatCompletionsHumanCopyProvider(options: { url: string; apiKey: string; model: string; fallbackModels?: string[]; sendReasoningOff?: boolean; fetchImpl?: typeof fetch }): HumanCopyProvider;
export function fitGeneratedCopy(output: unknown): unknown;
export class HumanCopyWorker {
  revision: number;
  provider: HumanCopyProvider | null | undefined;
  persistSharedCopy: ((requestId: string, entry: { fingerprint: string; copy: unknown; generatedAt: number }) => unknown | Promise<unknown>) | null;
  constructor(options?: { provider?: HumanCopyProvider | null; cachePath?: string | null; persistSharedCopy?: ((requestId: string, entry: { fingerprint: string; copy: unknown; generatedAt: number }) => unknown | Promise<unknown>) | null; concurrency?: number; quietMs?: number; maxWaitMs?: number; minIntervalMs?: number; retryMs?: number; maxRetryMs?: number; now?: () => number; warn?: (message: string) => void });
  load(): Promise<void>;
  start(): void;
  close(): void;
  pauseWhile(shouldPause: () => boolean): void;
  observe<T extends { humanRequests?: unknown[] }>(view: T): T;
  status(): { cached: number; queued: number; generating: number; failures: Array<{ reason: string; at: number }>; revision: number };
}
