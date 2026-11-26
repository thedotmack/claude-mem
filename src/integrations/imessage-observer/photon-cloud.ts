/**
 * Photon's cloud: a Photon project id and secret → the project's iMessage
 * lines, each with a gRPC address and a short-lived bearer token.
 *
 * This is the same token endpoint Photon's own Spectrum SDK uses. A project
 * with a dedicated line gets one address per line
 * (`<line id>.imsg.photon.codes:443`). A project on Photon's free or Pro
 * plan gets a shared line instead, and shared lines cannot join group chats,
 * so the observer refuses them with a plain explanation.
 *
 * Tokens are renewed when 80% of their lifetime has passed. The project
 * secret is only ever sent to Photon, never logged.
 */

export const PHOTON_CLOUD_URL = 'https://spectrum.photon.codes';

interface SharedTokenData { type: 'shared'; token: string; expiresIn: number }
interface DedicatedTokenData {
  type: 'dedicated';
  auth: Record<string, string>;
  numbers: Record<string, string | null>;
  expiresIn: number;
}
export type PhotonTokenData = SharedTokenData | DedicatedTokenData;

export interface PhotonProjectCredentials { projectId: string; projectSecret: string }

/** One dedicated line, ready to hand to the Photon SDK's gRPC client. */
export interface PhotonLine {
  id: string;
  phone: string;
  address: string;
  token: () => Promise<string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class PhotonCloudError extends Error {
  /** True when retrying cannot help: bad credentials, no line, or a shared line. */
  readonly fatal: boolean;
  constructor(message: string, readonly status?: number, fatal?: boolean) {
    super(message);
    this.name = 'PhotonCloudError';
    this.fatal = fatal ?? (status === 401 || status === 403 || status === 404);
  }
}

export const SHARED_LINE_MESSAGE = 'Your Photon project uses a shared iMessage line. Shared lines cannot join'
  + ' group chats, so there is nothing for the observer to hear. Group chats need a dedicated line, which'
  + ' is part of Photon\'s Business plan (see docs/imessage-group-observer.md).';

export async function issueImessageTokens(
  credentials: PhotonProjectCredentials,
  options: { fetch?: FetchLike; baseUrl?: string } = {},
): Promise<PhotonTokenData> {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
  const base = options.baseUrl ?? process.env.SPECTRUM_CLOUD_URL ?? PHOTON_CLOUD_URL;
  const basic = Buffer.from(`${credentials.projectId}:${credentials.projectSecret}`).toString('base64');
  const response = await doFetch(`${base}/projects/${encodeURIComponent(credentials.projectId)}/imessage/tokens`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new PhotonCloudError('Photon did not accept the project id and secret. Run: npx claude-mem imessage setup', response.status);
    }
    if (response.status === 404) {
      throw new PhotonCloudError('Photon has no iMessage line for this project yet. Add one on the Photon dashboard, then run setup again.', 404);
    }
    throw new PhotonCloudError(`Photon could not issue iMessage tokens (HTTP ${response.status}).`, response.status);
  }
  const body = await response.json() as { succeed?: boolean; data?: PhotonTokenData };
  const data = body?.data;
  if (!body?.succeed || !data || (data.type !== 'shared' && data.type !== 'dedicated')) {
    // Retrying cannot fix an answer this version cannot read, so this is fatal.
    throw new PhotonCloudError('Photon returned an answer the observer does not understand. Update claude-mem, then run: npx claude-mem imessage setup', response.status, true);
  }
  return data;
}

/** Keeps a project's line tokens fresh. */
export class PhotonCloudLines {
  private data: PhotonTokenData | null = null;
  private fetchedAt = 0;
  private refreshing: Promise<PhotonTokenData> | null = null;

  constructor(
    private readonly credentials: PhotonProjectCredentials,
    private readonly options: { fetch?: FetchLike; baseUrl?: string; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private stale(): boolean {
    if (!this.data) return true;
    return this.now() - this.fetchedAt >= this.data.expiresIn * 1000 * 0.8;
  }

  private async current(): Promise<PhotonTokenData> {
    if (!this.stale()) return this.data!;
    if (!this.refreshing) {
      this.refreshing = issueImessageTokens(this.credentials, this.options).then(data => {
        this.data = data;
        this.fetchedAt = this.now();
        return data;
      }).finally(() => { this.refreshing = null; });
    }
    return await this.refreshing;
  }

  /** A rejected stream token can be rotated before its advertised expiry. */
  invalidateTokens(): void { this.data = null; }

  /** The project's dedicated lines. Throws for a shared line, which cannot see group chats. */
  async lines(): Promise<PhotonLine[]> {
    const data = await this.current();
    if (data.type === 'shared') throw new PhotonCloudError(SHARED_LINE_MESSAGE, undefined, true);
    return Object.keys(data.auth).sort().map(id => ({
      id,
      phone: data.numbers[id] ?? 'unknown number',
      address: `${id}.imsg.photon.codes:443`,
      token: async () => {
        const fresh = await this.current();
        if (fresh.type !== 'dedicated' || !fresh.auth[id]) {
          throw new PhotonCloudError(`Photon no longer lists the line ${id}. Run: npx claude-mem imessage setup`);
        }
        return fresh.auth[id]!;
      },
    }));
  }
}
