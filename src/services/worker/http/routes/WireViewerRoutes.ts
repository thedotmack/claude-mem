import express, { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { isOwnPageOrigin, type WorkerOriginPolicy } from '../origin-policy.js';
import { logger } from '../../../../utils/logger.js';
import { paths, wireGatewaySubdirPath } from '../../../../shared/paths.js';
import { loadWireGatewayConfig } from '../../../wire-gateway/config.js';
import {
  WIRE_STATUS_REQUEST_TIMEOUT_MS,
  readWireGatewayRuntimeState,
  wireStatusGatewayOrigin,
} from '../../../wire-gateway/WireGatewayService.js';
import {
  describeDirectHttpFailure,
  requestDirectlyWithOutcome,
  type DirectHttpOutcome,
  type DirectHttpRequest,
} from '../../../wire-gateway/direct-http.js';
import { LIVE_TRACE_LONG_POLL_MS } from '../../../wire-gateway/trace/live-trace-feed.js';
import {
  clearWireRecordings,
  readWireRecordingConsentFile,
  setWireRecordingConsent,
} from '../../../wire-gateway/privacy/recording-consent.js';
import { WireUsageLedgerReader } from '../../../wire-gateway/metrics/usage-ledger.js';
import { buildWireUsageSummary } from '../../../wire-gateway/metrics/usage-summary.js';

/**
 * Status, routes, a call's bodies and a trace asked without `wait` are
 * answered from the gateway's memory or one small file, so they get the
 * budget `wire status` gives the running gateway.
 */
const GATEWAY_QUICK_ANSWER_TIMEOUT_MS = WIRE_STATUS_REQUEST_TIMEOUT_MS;

/**
 * A long-poll holds for up to the feed's own 25 s wait (LIVE_TRACE_LONG_POLL_MS),
 * then answers like any quick request; anything later means the gateway is stuck.
 */
const GATEWAY_LONG_POLL_TIMEOUT_MS = LIVE_TRACE_LONG_POLL_MS + GATEWAY_QUICK_ANSWER_TIMEOUT_MS;

export const WIRE_GATEWAY_NOT_RUNNING_ERROR = 'wire gateway not running';

const consentSchema = z.object({ recording: z.boolean() }).strict();
const emptyBodySchema = z.object({}).strict();

/**
 * Whether a request was sent by the viewer's own page: it carries an Origin
 * and that Origin is the worker's own (isOwnPageOrigin: this host:port, its
 * other loopback names, or CLAUDE_MEM_ALLOWED_ORIGINS / CLAUDE_MEM_PUBLIC_URL).
 *
 * What it protects against is other browser pages: CORS lets any
 * http://localhost:* or http://127.0.0.1:* page call the worker, and a
 * browser always sends such a page's Origin, which this refuses. It does not
 * authenticate a local program: anything that can open a socket to the
 * worker can send whatever Origin it likes. Consent changes also require the
 * header to be present, so a plain script or curl (which sends none) must
 * choose to imitate the viewer, rather than turning recording on by accident.
 */
export function isViewerOriginRequest(req: Pick<Request, 'headers'>, policy: WorkerOriginPolicy): boolean {
  const origin = req.headers?.origin;
  return typeof origin === 'string' && origin.length > 0 && isOwnPageOrigin(origin, req.headers.host, policy);
}

export interface WireViewerRoutesOptions {
  /** Which browser origins are the viewer's own page (the worker's own policy). */
  originPolicy: WorkerOriginPolicy;
  /** Where the gateway listens: its saved runtime address, else the configured one. */
  gatewayOrigin?: () => string;
  /** Test seam for the loopback request (direct-http.ts never takes a proxy). */
  requestGateway?: (request: DirectHttpRequest) => Promise<DirectHttpOutcome>;
  /** The settings consent and usage need; defaults to loadWireGatewayConfig(). */
  loadConfig?: () => { recordingForcedOff: boolean; retentionDays: number };
  consentFilePath?: string;
  recordingsDirectory?: string;
  usageDirectory?: string;
}

/**
 * The viewer's Wire page (plan Phase 15). The browser never calls the
 * gateway's port (it sends no CORS headers, by design): status, routes and
 * the live call feed are forwarded here, over loopback, and answer 503
 * `{error: "wire gateway not running"}` when nothing listens.
 *
 * Every route answers the viewer's own page only. A request with an Origin
 * that is not the viewer's (any other localhost page CORS admits) gets 403:
 * call bodies, the trace, routes and usage are this person's data, not
 * something another local web app may read. Requests with no Origin (the
 * CLI, curl) may read; consent changes need the viewer's Origin.
 *
 * Consent and usage are not forwarded. Both live in files the gateway
 * shares with this worker (consent.json, usage/*.jsonl), and:
 * - forwarding a consent change would give the gateway its own way to turn
 *   recording on, reachable by any loopback client; here the one way in is
 *   the viewer's own origin, and the gateway reads consent.json on every check;
 * - usage is history on disk that stays true while the gateway is down, and
 *   reading it here keeps the ledger's parsing off the relay's process.
 */
export class WireViewerRoutes extends BaseRouteHandler {
  private readonly options: WireViewerRoutesOptions;
  private readonly usageReader: WireUsageLedgerReader;

  constructor(options: WireViewerRoutesOptions) {
    super();
    this.options = options;
    this.usageReader = new WireUsageLedgerReader({ directory: options.usageDirectory });
  }

  setupRoutes(app: express.Application): void {
    const viewerOnly = this.refuseOtherPages;
    app.get('/api/wire/status', viewerOnly, this.forwardToGateway('/wire/status', () => GATEWAY_QUICK_ANSWER_TIMEOUT_MS));
    app.get('/api/wire/routes', viewerOnly, this.forwardToGateway('/wire/routes', () => GATEWAY_QUICK_ANSWER_TIMEOUT_MS));
    app.get('/api/wire/trace', viewerOnly, this.forwardToGateway('/wire/trace', req => (req.query.wait === undefined ? GATEWAY_QUICK_ANSWER_TIMEOUT_MS : GATEWAY_LONG_POLL_TIMEOUT_MS)));
    app.get('/api/wire/call', viewerOnly, this.forwardToGateway('/wire/call', () => GATEWAY_QUICK_ANSWER_TIMEOUT_MS));
    app.get('/api/wire/consent', viewerOnly, this.handleGetConsent);
    app.post('/api/wire/consent', viewerOnly, validateBody(consentSchema), this.handleSetConsent);
    app.post('/api/wire/consent/clear', viewerOnly, validateBody(emptyBodySchema), this.handleClearRecordings);
    app.get('/api/wire/usage', viewerOnly, this.handleGetUsage);
  }

  /** 403 for a browser page that is not the viewer's own; a request without an Origin goes on. */
  private refuseOtherPages = (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.origin === undefined || isViewerOriginRequest(req, this.options.originPolicy)) {
      next();
      return;
    }
    logger.warn('SECURITY', 'Refused a wire viewer request from another page', { path: req.path, origin: req.headers.origin });
    res.status(403).json({ error: 'The wire routes answer only the claude-mem viewer page (or a client that sends no Origin, such as the CLI).' });
  };

  private gatewayOrigin(): string {
    return this.options.gatewayOrigin?.() ?? wireStatusGatewayOrigin(loadWireGatewayConfig(), readWireGatewayRuntimeState());
  }

  private config(): { recordingForcedOff: boolean; retentionDays: number } {
    return this.options.loadConfig?.() ?? loadWireGatewayConfig();
  }

  /** GET <gateway><gatewayPath> with the request's own query; the answer is passed through as is. */
  private forwardToGateway(gatewayPath: string, timeoutMsFor: (req: Request) => number) {
    return this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
      const query = new URL(req.originalUrl ?? req.url, 'http://worker').search;
      const timeoutMs = timeoutMsFor(req);
      // A long-poll the browser left (tab closed, page changed) must not hold the gateway's waiter.
      // req's 'close', not res's: Bun 1.3.9's node:http never fires res 'close' for a client that left (probed).
      const clientLeft = new AbortController();
      req.on('close', () => {
        if (!res.writableEnded) clientLeft.abort();
      });
      const outcome = await (this.options.requestGateway ?? requestDirectlyWithOutcome)({
        url: `${this.gatewayOrigin()}${gatewayPath}${query}`,
        timeoutMs,
        signal: clientLeft.signal,
      });
      if ('response' in outcome) {
        res.status(outcome.response.statusCode).type('application/json').set('Cache-Control', 'no-store').send(outcome.response.bodyText);
        return;
      }
      const { failure } = outcome;
      if (failure.reason === 'aborted') {
        logger.debug('HTTP', 'Viewer left a wire gateway request', { gatewayPath });
        return;
      }
      if (failure.reason === 'unreachable') {
        res.status(503).json({ error: WIRE_GATEWAY_NOT_RUNNING_ERROR });
        return;
      }
      const message = describeDirectHttpFailure(failure, 'the wire gateway');
      logger.warn('HTTP', 'Wire gateway request failed', { gatewayPath, reason: failure.reason, message });
      res.status(failure.reason === 'timeout' ? 504 : 502).json({ error: message });
    });
  }

  private handleGetConsent = this.wrapHandler((_req: Request, res: Response): void => {
    const config = this.config();
    // An unreadable consent.json throws here and answers 500 with why: unknown is never shown as "off".
    const consent = readWireRecordingConsentFile(this.options.consentFilePath ?? paths.wireGatewayConsent());
    res.set('Cache-Control', 'no-store').json({
      recording: consent?.recording === true,
      forcedOff: config.recordingForcedOff,
      effective: consent?.recording === true && !config.recordingForcedOff,
      decidedAt: consent?.decidedAt || null,
      retentionDays: config.retentionDays,
      recordingsDirectory: this.options.recordingsDirectory ?? wireGatewaySubdirPath('recordings'),
    });
  });

  private refuseUnlessViewerOrigin(req: Request, res: Response): boolean {
    if (isViewerOriginRequest(req, this.options.originPolicy)) return false;
    logger.warn('SECURITY', 'Refused a wire recording consent change from outside the viewer', { path: req.path, origin: req.headers.origin ?? null });
    res.status(403).json({
      error: 'Wire recording consent changes only from the claude-mem viewer page (or claude-mem wire consent at a terminal)',
    });
    return true;
  }

  private handleSetConsent = this.wrapHandler((req: Request, res: Response): void => {
    if (this.refuseUnlessViewerOrigin(req, res)) return;
    const { recording } = req.body as z.infer<typeof consentSchema>;
    const consent = setWireRecordingConsent(recording, this.options.consentFilePath ?? paths.wireGatewayConsent());
    logger.info('WIRE', `Wire recording turned ${recording ? 'on' : 'off'} from the viewer`, { generation: consent.generation });
    this.handleGetConsent(req, res);
  });

  private handleClearRecordings = this.wrapHandler((req: Request, res: Response): void => {
    if (this.refuseUnlessViewerOrigin(req, res)) return;
    const consent = clearWireRecordings({ consentFilePath: this.options.consentFilePath, recordingsDirectory: this.options.recordingsDirectory });
    logger.info('WIRE', 'Wire recordings cleared from the viewer', { generation: consent.generation });
    this.handleGetConsent(req, res);
  });

  private handleGetUsage = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const { retentionDays } = this.config();
    const ledger = await this.usageReader.readRetained(retentionDays);
    res.set('Cache-Control', 'no-store').json(buildWireUsageSummary(ledger, retentionDays));
  });
}
