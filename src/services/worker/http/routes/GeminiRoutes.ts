import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { RateLimitTracker } from '../../gemini/RateLimitTracker.js';
import { DynamicModelRegistry } from '../../gemini/DynamicModelRegistry.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { paths } from '../../../../shared/paths.js';
import { getCredential } from '../../../../shared/EnvManager.js';

export class GeminiRoutes extends BaseRouteHandler {
  constructor() {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/gemini/status', this.handleGetStatus.bind(this));
    app.post('/api/gemini/refresh', this.handleRefreshModels.bind(this));
    app.post('/api/gemini/model', this.handleSelectModel.bind(this));
    app.post('/api/gemini/calibrate-rpd', this.handleCalibrateRpd.bind(this));
    app.post('/api/gemini/tier', this.handleSetTier.bind(this));
  }

  private handleGetStatus = this.wrapHandler((req: Request, res: Response): void => {
    const tracker = RateLimitTracker.getInstance();
    res.json(tracker.getStatus());
  });

  private handleRefreshModels = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    const registry = DynamicModelRegistry.getInstance();
    await registry.discoverModels(apiKey, true);

    const tracker = RateLimitTracker.getInstance();
    res.json(tracker.getStatus());
  });

  private handleSelectModel = this.wrapHandler((req: Request, res: Response): void => {
    const { model, autoFallback } = req.body ?? {};
    const tracker = RateLimitTracker.getInstance();

    if (typeof model === 'string' && model) {
      tracker.setActiveModel(model);
    }
    if (typeof autoFallback === 'boolean') {
      tracker.setAutoFallback(autoFallback);
    }

    res.json(tracker.getStatus());
  });

  private handleCalibrateRpd = this.wrapHandler((req: Request, res: Response): void => {
    const { model, count } = req.body ?? {};
    if (typeof model !== 'string' || typeof count !== 'number' || count < 0) {
      res.status(400).json({ error: 'Invalid model or count. Expected model: string, count: non-negative number' });
      return;
    }
    const tracker = RateLimitTracker.getInstance();
    tracker.calibrateRpd(model, count);
    res.json(tracker.getStatus());
  });

  private handleSetTier = this.wrapHandler((req: Request, res: Response): void => {
    const { tier } = req.body ?? {};
    if (tier !== 'free' && tier !== 'payg') {
      res.status(400).json({ error: 'Invalid tier. Expected "free" or "payg"' });
      return;
    }
    const tracker = RateLimitTracker.getInstance();
    tracker.setTier(tier);
    res.json(tracker.getStatus());
  });
}
