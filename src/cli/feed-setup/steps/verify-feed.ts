/**
 * Step 6: Verify Live Feed
 *
 * Starts/restarts the feed daemon via the worker HTTP API and optionally
 * waits for the first observation to come through.
 */

import * as p from '@clack/prompts';
import { getWorkerPort } from '../../../shared/worker-utils.js';

export async function verifyFeedStep(nonInteractive: boolean = false): Promise<void> {
  const port = getWorkerPort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const s = p.spinner();
  s.start('Starting feed daemon...');

  try {
    const res = await fetch(`${baseUrl}/api/feed/start`, { method: 'POST' });
    const data = await res.json() as Record<string, unknown>;

    if (!data.success) {
      s.stop('Feed daemon failed to start');
      p.log.warn(data.message as string || 'Unknown error');
      return;
    }

    s.stop('Feed daemon started');
  } catch (err) {
    s.stop('Could not reach worker');
    p.log.warn(
      'Worker service is not running. The feed will start automatically on next worker boot.'
    );
    return;
  }

  if (nonInteractive) return;

  // Wait for first observation (optional, 30s timeout)
  const s2 = p.spinner();
  s2.start('Waiting for first observation (30s timeout)...');

  const timeout = 30_000;
  const start = Date.now();
  let receivedObservation = false;

  while (Date.now() - start < timeout) {
    try {
      const statusRes = await fetch(`${baseUrl}/api/feed/status`);
      const statusData = await statusRes.json() as Record<string, unknown>;
      if ((statusData.lastMessageTime as number) > start) {
        receivedObservation = true;
        break;
      }
    } catch {
      // Worker may not be reachable yet
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (receivedObservation) {
    s2.stop('First observation sent to Telegram!');
  } else {
    s2.stop('No observations received yet');
    p.log.info(
      'This is normal if no Claude Code sessions are active.\n' +
      'Observations will appear in your Telegram group when you use Claude Code.'
    );
  }
}
