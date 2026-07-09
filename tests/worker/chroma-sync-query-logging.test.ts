import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { ChromaSync } from '../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../src/services/sync/ChromaMcpManager.js';
import { logger } from '../../src/utils/logger.js';

describe('ChromaSync query logging', () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let getInstanceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    getInstanceSpy?.mockRestore();
  });

  it('redacts prompt text in generic query failures', async () => {
    const rawQuery = 'secret prompt text with api_key=abc123';
    const callTool = mock(() => {
      throw new Error('query blew up');
    });
    getInstanceSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool } as any);

    const sync = new ChromaSync('test-project');
    (sync as any).collectionCreated = true;

    await expect(sync.queryChroma(rawQuery, 5)).rejects.toThrow('query blew up');

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(rawQuery);
    expect(errorSpy.mock.calls[0]?.[2]).toEqual({ project: 'test-project', queryLength: rawQuery.length });
  });

  it('redacts prompt text in connection-loss query failures', async () => {
    const rawQuery = 'secret prompt text with token=xyz789';
    const callTool = mock(() => {
      throw new Error('ECONNREFUSED');
    });
    getInstanceSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({ callTool } as any);

    const sync = new ChromaSync('test-project');
    (sync as any).collectionCreated = true;

    await expect(sync.queryChroma(rawQuery, 5)).rejects.toThrow('connection lost');

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(rawQuery);
    expect(errorSpy.mock.calls[0]?.[2]).toEqual({ project: 'test-project', queryLength: rawQuery.length });
  });
});
