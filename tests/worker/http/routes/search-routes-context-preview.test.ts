import { afterAll, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import * as realContextGenerator from '../../../../src/services/context-generator.js';

const realContextGeneratorSnapshot = { ...realContextGenerator };
const generateContextStub = mock(async (input: { platformSource?: string }) =>
  `preview-${input.platformSource ?? 'all'}`
);
mock.module('../../../../src/services/context-generator.js', () => ({
  ...realContextGeneratorSnapshot,
  generateContext: generateContextStub,
}));

import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

function capturePreviewHandler(): (req: Request, res: Response) => void {
  let handler: ((req: Request, res: Response) => void) | undefined;
  new SearchRoutes({} as any).setupRoutes({
    use: mock(() => {}),
    get: mock((path: string, routeHandler: (req: Request, res: Response) => void) => {
      if (path === '/api/context/preview') handler = routeHandler;
    }),
    post: mock(() => {}),
  } as any);
  if (!handler) throw new Error('Preview route was not registered');
  return handler;
}

describe('/api/context/preview platform scoping', () => {
  afterAll(() => {
    mock.module('../../../../src/services/context-generator.js', () => realContextGeneratorSnapshot);
  });

  it('passes the selected source to context generation and leaves all sources unfiltered', async () => {
    const handler = capturePreviewHandler();

    for (const [selectedSource, expectedSource] of [
      ['Claude Code', 'claude'],
      ['Codex CLI', 'codex'],
      [undefined, undefined],
    ] as const) {
      const send = mock(() => {});
      const req = {
        query: { project: 'shared-project', ...(selectedSource ? { platformSource: selectedSource } : {}) },
        get: () => undefined,
      } as unknown as Request;
      const res = { setHeader: mock(() => {}), send } as unknown as Response;

      handler(req, res);
      await new Promise(resolve => setImmediate(resolve));

      expect(generateContextStub.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
        projects: ['shared-project'],
        ...(expectedSource ? { platformSource: expectedSource } : {}),
      }));
      if (!expectedSource) {
        expect(generateContextStub.mock.calls.at(-1)?.[0]).not.toHaveProperty('platformSource');
      }
      expect(send).toHaveBeenCalledWith(`preview-${expectedSource ?? 'all'}`);
    }
  });
});
