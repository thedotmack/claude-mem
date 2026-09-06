import { describe, it, expect } from 'bun:test';
import {
  FOREIGN_PYTHON_ENV_VARS,
  stripForeignPythonEnv,
} from '../../src/shared/uvx-env.js';

// #3552 — an activated venv / conda shell must not leak its interpreter into
// the uvx child, or chromadb imports the outer site-packages on top of uv's
// and dies on a numpy ABI clash *silently* (the subprocess fails before the
// MCP handshake, so semantic sync just stops).

const POLLUTED_ENV = {
  PATH: '/usr/bin:/bin',
  VIRTUAL_ENV: '/home/u/.venvs/proj',
  PYTHONHOME: '/usr/lib/python3.9',
  PYTHONPATH: '/home/u/.venvs/proj/lib/python3.9/site-packages',
  CONDA_PREFIX: '/opt/conda/envs/ml',
  CONDA_DEFAULT_ENV: 'ml',
  ANONYMIZED_TELEMETRY: 'false',
} as const;

describe('stripForeignPythonEnv (#3552)', () => {
  it('removes every foreign-Python variable from a polluted env', () => {
    const env: Record<string, string> = { ...POLLUTED_ENV };

    stripForeignPythonEnv(env);

    for (const key of FOREIGN_PYTHON_ENV_VARS) {
      expect(env[key]).toBeUndefined();
      expect(Object.keys(env)).not.toContain(key);
    }
  });

  it('preserves everything that is not a foreign-Python variable', () => {
    const env: Record<string, string> = { ...POLLUTED_ENV };

    stripForeignPythonEnv(env);

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.ANONYMIZED_TELEMETRY).toBe('false');
  });

  it('is a no-op on a clean env', () => {
    const env: Record<string, string> = { PATH: '/usr/bin', HOME: '/home/u' };

    stripForeignPythonEnv(env);

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });

  it('covers exactly the five variables the issue calls out', () => {
    expect([...FOREIGN_PYTHON_ENV_VARS].sort()).toEqual([
      'CONDA_DEFAULT_ENV',
      'CONDA_PREFIX',
      'PYTHONHOME',
      'PYTHONPATH',
      'VIRTUAL_ENV',
    ]);
  });
});

describe('stripForeignPythonEnv on Windows is case-insensitive (#3552)', () => {
  // Windows env names are case-insensitive, so `PythonPath` IS `PYTHONPATH` to
  // the OS and to CPython. An exact-uppercase delete would miss it entirely and
  // the ABI clash fires anyway. Platform is injected so this runs off-Windows.
  const MIXED_CASE_ENV = {
    PATH: 'C:\\Windows\\System32',
    PythonPath: 'C:\\foreign-venv\\Lib\\site-packages',
    Virtual_Env: 'C:\\foreign-venv',
    virtualenv: 'C:\\decoy',
    pythonhome: 'C:\\Python39',
    Conda_Prefix: 'C:\\conda\\envs\\ml',
    CONDA_DEFAULT_env: 'ml',
  } as const;

  it('removes mixed-case variants on win32', () => {
    const env: Record<string, string> = { ...MIXED_CASE_ENV };

    stripForeignPythonEnv(env, 'win32');

    const remaining = Object.keys(env).map(key => key.toLowerCase());
    for (const key of FOREIGN_PYTHON_ENV_VARS) {
      expect(remaining).not.toContain(key.toLowerCase());
    }
    // Not a foreign-Python variable — `virtualenv` is a distinct name, not a
    // case variant of VIRTUAL_ENV, so it must survive.
    expect(env.virtualenv).toBe('C:\\decoy');
    expect(env.PATH).toBe('C:\\Windows\\System32');
  });

  it('leaves no duplicate case-variant of a stripped key behind', () => {
    const env: Record<string, string> = {
      PYTHONPATH: '/a',
      PythonPath: '/b',
      pythonpath: '/c',
      KEEP: 'yes',
    };

    stripForeignPythonEnv(env, 'win32');

    expect(Object.keys(env)).toEqual(['KEEP']);
  });

  it('stays exact-match on posix, where case is significant', () => {
    const env: Record<string, string> = {
      PYTHONPATH: '/strip-me',
      PythonPath: '/genuinely-different-variable',
    };

    stripForeignPythonEnv(env, 'linux');

    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PythonPath).toBe('/genuinely-different-variable');
  });
});

// The env that actually reaches chroma-mcp is asserted end-to-end against the
// real uvx spawn in tests/services/sync/chroma-mcp-manager-singleton.test.ts
// ("never passes a foreign Python interpreter to the uvx child"). That is the
// test that proves #3552 is fixed; the cases above pin the shared rule itself.
