import type express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { MediaError, isMediaErrorCode, type MediaErrorCode } from '../../../../shared/media-contract.js';
import { assertMediaId, type MediaMetadata, type MediaStore } from '../../../media/store.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { isOwnPageOrigin } from '../middleware.js';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_PAGE_POLICY = { allowedOrigins: [], workerHost: '' };

/** Media is private even when the operator enables LAN/TV text reads. */
export function isTrustedMediaRead(req: Request): boolean {
  // Copy the worker's loopback trust boundary, using the actual socket rather
  // than req.ip: Express trust-proxy configuration must not grant pixel access.
  if (!LOOPBACK_PEERS.has(req.socket.remoteAddress ?? '')) return false;
  if (Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-') || name === 'x-real-ip')) return false;
  const host = req.headers.host;
  if (!host || /[\\/@?#\s]/.test(host)) return false;
  try {
    const target = new URL(`${req.protocol}://${host}`);
    if (!LOOPBACK_HOSTS.has(target.hostname)) return false;
  } catch { return false; }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (origin !== undefined) {
    if (typeof origin !== 'string') return false;
    try {
      const page = new URL(origin);
      if (page.protocol !== `${req.protocol}:` || page.origin !== origin.toLowerCase()) return false;
    } catch { return false; }
    // Same worker port, including localhost/127.0.0.1/IPv6 aliases. Unlike
    // general text CORS, another localhost port or allowlisted public page
    // does not get access to retained image bytes.
    if (!isOwnPageOrigin(origin, host, LOCAL_PAGE_POLICY)) return false;
  }
  if (referer !== undefined) {
    if (typeof referer !== 'string') return false;
    try {
      const page = new URL(referer);
      if (page.protocol !== `${req.protocol}:` || page.username || page.password
        || !isOwnPageOrigin(page.origin, host, LOCAL_PAGE_POLICY)) return false;
    } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) {
    if (site !== 'same-origin' && site !== 'same-site' && site !== 'none' && site !== 'cross-site') return false;
    // Image tags may omit Origin. Fetch metadata and Referer close that read
    // path; a different localhost port is also a foreign browser page.
    if ((site === 'cross-site' || site === 'same-site') && !origin && !referer) return false;
  }
  return true;
}

function safeMetadata(metadata: MediaMetadata): MediaMetadata {
  const variant = (value: MediaMetadata['viewer']): MediaMetadata['viewer'] => value && ({
    sha256: value.sha256, width: value.width, height: value.height,
    byteLength: value.byteLength, mimeType: value.mimeType,
  });
  // Project the wire fields explicitly: adding internal storage/provenance to
  // the store later must not make local locators or object keys public.
  return {
    id: metadata.id, state: metadata.state, recipe: metadata.recipe,
    encoderVersion: metadata.encoderVersion, viewer: variant(metadata.viewer),
    llm: variant(metadata.llm), failureCode: metadata.failureCode,
  };
}

/**
 * Express's res.json/res.send add a weak ETag (app `etag` setting) and answer
 * If-None-Match with 304. Private media responses carry no cache validators,
 * so JSON is written directly.
 */
function sendJsonWithoutCacheValidators(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export class MediaRoutes extends BaseRouteHandler {
  constructor(
    private readonly getStore: () => Pick<MediaStore, 'getMetadata' | 'readVariant'>,
    /** Lazily downloads and verifies a second-device replica before any read. */
    private readonly resolveReplica: (id: string) => Promise<void> = async () => {},
  ) { super(); }

  setupRoutes(app: express.Application): void {
    app.get('/api/media/:id', this.guard, this.getMetadata);
    app.get('/api/media/:id/:variant', this.guard, this.getVariant);
  }

  private guard = (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!isTrustedMediaRead(req)) {
      sendJsonWithoutCacheValidators(res, 403, { error: 'Forbidden', code: 'unauthorized_owner' });
      return;
    }
    next();
  };

  // Async handlers make both synchronous database errors and asynchronous I/O
  // use the bounded error response below, never BaseRouteHandler's raw error.
  private getMetadata = this.wrapHandler(async (req, res): Promise<void> => {
    const id = assertMediaId(req.params.id);
    await this.resolveReplica(id);
    const metadata = this.getStore().getMetadata(id);
    if (metadata.id !== id || metadata.state === 'deleted') throw new MediaError('media_not_found');
    sendJsonWithoutCacheValidators(res, 200, safeMetadata(metadata));
  });

  private getVariant = this.wrapHandler(async (req, res): Promise<void> => {
    const id = assertMediaId(req.params.id);
    const variant = req.params.variant;
    if (variant !== 'viewer' && variant !== 'llm') throw new MediaError('invalid_manifest');
    await this.resolveReplica(id);
    const store = this.getStore();
    const metadata = store.getMetadata(id);
    if (metadata.id !== id || metadata.state === 'deleted') throw new MediaError('media_not_found');
    if (metadata.state !== 'ready') throw new MediaError('media_not_ready');
    const bytes = await store.readVariant(id, variant);
    // Recheck after I/O so a deletion that won while the read was pending
    // cannot return a now-tombstoned attachment.
    const current = store.getMetadata(id);
    if (current.id !== id || current.state === 'deleted') throw new MediaError('media_not_found');
    if (current.state !== 'ready') throw new MediaError('media_not_ready');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', bytes.byteLength);
    res.end(bytes);
  });

  protected override handleError(res: Response, error: Error): void {
    const code: MediaErrorCode = error instanceof MediaError && isMediaErrorCode(error.code)
      ? error.code : 'storage_unavailable';
    const status = code === 'invalid_manifest' ? 400 : code === 'media_not_found' ? 404
      : code === 'media_not_ready' ? 409 : 503;
    if (!res.headersSent) sendJsonWithoutCacheValidators(res, status, { error: 'Media request failed', code });
  }
}
