import express, { Request, Response } from 'express';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { defaultSigninReminderDeps, resolveSigninReminder, type SigninReminderDeps } from '../../../signin-reminder.js';

/**
 * GET /api/signin/reminder?session_id=… — the SessionStart hook asks the
 * worker (the hook itself must stay fast) whether to remind an unclaimed
 * agent-run install to finish signing in, with a fresh link. Always answers
 * 200; `{show:false}` covers every failure.
 */
export class SigninRoutes extends BaseRouteHandler {
  constructor(
    private readonly deps: SigninReminderDeps = defaultSigninReminderDeps(
      () => SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_SIGNIN_REMINDER !== 'false',
    ),
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/signin/reminder', this.handleReminder.bind(this));
  }

  private handleReminder = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.slice(0, 200) : '';
    const reminder = await resolveSigninReminder(sessionId, this.deps);
    res.json(reminder.show
      ? { show: true, url: reminder.url, expires_in: reminder.expiresIn }
      : { show: false, reason: reminder.reason });
  });
}
