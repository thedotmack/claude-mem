import { Response } from 'express';

export function flushResponseThen(
  res: Response,
  payload: unknown,
  action: () => void | Promise<void>
): void {
  res.on('finish', async () => {
    try {
      await action();
    } finally {
      process.exit(0);
    }
  });
  res.json(payload);
}
