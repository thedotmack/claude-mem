
import { describe, it, expect, afterEach } from 'bun:test';
import http from 'http';
import {
  assessHardware,
  localModelSettingsDelta,
  probeLmStudio,
  probeOllama,
} from '../../src/shared/local-model.js';

const GB = 1024 ** 3;

describe('local model detection', () => {
  describe('assessHardware', () => {
    it('maps RAM to conservative capability tiers', () => {
      expect(assessHardware({ totalMemBytes: 4 * GB }).tier).toBe('insufficient');
      expect(assessHardware({ totalMemBytes: 8 * GB }).tier).toBe('small');
      expect(assessHardware({ totalMemBytes: 16 * GB }).tier).toBe('medium');
      expect(assessHardware({ totalMemBytes: 32 * GB }).tier).toBe('large');
      expect(assessHardware({ totalMemBytes: 128 * GB }).tier).toBe('large');
    });

    it('recommends no model below 8GB', () => {
      const hw = assessHardware({ totalMemBytes: 6 * GB });
      expect(hw.recommendedParamSize).toBeNull();
      expect(hw.recommendedOllamaModel).toBeNull();
    });

    it('recommends a concrete model per tier', () => {
      expect(assessHardware({ totalMemBytes: 8 * GB }).recommendedOllamaModel).toBe('qwen2.5:3b');
      expect(assessHardware({ totalMemBytes: 16 * GB }).recommendedOllamaModel).toBe('qwen2.5:7b');
      expect(assessHardware({ totalMemBytes: 64 * GB }).recommendedOllamaModel).toBe('qwen2.5:14b');
    });

    it('detects Apple Silicon', () => {
      expect(assessHardware({ totalMemBytes: 16 * GB, platform: 'darwin', arch: 'arm64' }).appleSilicon).toBe(true);
      expect(assessHardware({ totalMemBytes: 16 * GB, platform: 'linux', arch: 'x64' }).appleSilicon).toBe(false);
    });

    it('probes the real machine without throwing when no overrides are given', () => {
      const hw = assessHardware();
      expect(hw.ramGb).toBeGreaterThan(0);
      expect(hw.cpuCount).toBeGreaterThan(0);
    });
  });

  describe('runtime probes', () => {
    let server: http.Server | undefined;

    afterEach(async () => {
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server!.close(err => err ? reject(err) : resolve());
        });
      }
      server = undefined;
    });

    async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<string> {
      server = http.createServer(handler);
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      return `http://127.0.0.1:${port}`;
    }

    it('detects a fake Ollama and lists its models', async () => {
      const base = await serve((req, res) => {
        if (req.url === '/api/tags') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:8b' }] }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      const probe = await probeOllama(base);
      expect(probe.detected).toBe(true);
      expect(probe.models).toEqual(['qwen2.5:7b', 'llama3.1:8b']);
      expect(probe.openAiBaseUrl).toBe(`${base}/v1`);
    });

    it('detects a fake LM Studio and lists its models', async () => {
      const base = await serve((req, res) => {
        if (req.url === '/v1/models') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct' }] }));
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      const probe = await probeLmStudio(base);
      expect(probe.detected).toBe(true);
      expect(probe.models).toEqual(['qwen2.5-7b-instruct']);
    });

    it('reports not-detected when nothing listens on the port', async () => {
      // Grab a free port, then close it so the probe hits a dead socket.
      const base = await serve((_req, res) => res.end());
      await new Promise<void>((resolve, reject) => {
        server!.close(err => err ? reject(err) : resolve());
      });
      const probe = await probeOllama(base);
      expect(probe.detected).toBe(false);
      expect(probe.models).toEqual([]);
    });

    it('reports not-detected on a non-OK response', async () => {
      const base = await serve((_req, res) => {
        res.statusCode = 500;
        res.end();
      });
      const probe = await probeLmStudio(base);
      expect(probe.detected).toBe(false);
    });
  });

  describe('localModelSettingsDelta', () => {
    it('sets exactly the three provider settings and nothing else', () => {
      expect(localModelSettingsDelta('http://127.0.0.1:11434/v1', 'qwen2.5:7b')).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'http://127.0.0.1:11434/v1',
        CLAUDE_MEM_OPENROUTER_MODEL: 'qwen2.5:7b',
      });
    });
  });
});
