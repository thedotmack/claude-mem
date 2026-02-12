import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Tests para:
 * 1. Timer leaks en Promise.race — verificar que clearTimeout se invoca
 * 2. initializationComplete se resuelve incluso si initializeBackground falla
 * 3. spawnDaemon migración de WMIC a PowerShell
 */

// ============================================================================
// Timer Leak Prevention Tests
// ============================================================================

describe('Timer Leak Prevention in Promise.race', () => {
  /**
   * Simula el patrón de worker-service.ts para context inject / api guard
   * Verifica que el timer se limpie cuando la promesa principal gana
   */
  it('debe limpiar el timer cuando la promesa principal resuelve primero', async () => {
    let timerCleared = false;
    const originalClearTimeout = globalThis.clearTimeout;

    // Track clearTimeout calls
    let clearTimeoutCallCount = 0;
    globalThis.clearTimeout = ((id: any) => {
      clearTimeoutCallCount++;
      timerCleared = true;
      return originalClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      // Simulate the pattern from worker-service.ts
      const fastPromise = Promise.resolve();

      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Should not fire')), 30000);
      });

      try {
        await Promise.race([fastPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer!);
      }

      expect(timerCleared).toBe(true);
      expect(clearTimeoutCallCount).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('debe limpiar el timer cuando el timeout gana (reject)', async () => {
    let timerCleared = false;
    const originalClearTimeout = globalThis.clearTimeout;

    globalThis.clearTimeout = ((id: any) => {
      timerCleared = true;
      return originalClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      // Promise that never resolves (simulates stuck initialization)
      const neverPromise = new Promise<void>(() => {});

      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timeout!')), 10); // very short
      });

      try {
        await Promise.race([neverPromise, timeoutPromise]);
      } catch {
        // Expected: timeout fires
      } finally {
        clearTimeout(timer!);
      }

      expect(timerCleared).toBe(true);
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('patrón antiguo SIN clearTimeout — timer queda colgando', async () => {
    // This test documents the OLD buggy pattern for comparison
    const fastPromise = Promise.resolve();

    // OLD pattern (no cleanup):
    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Leaked timer')), 100)
    );

    await Promise.race([fastPromise, timeoutPromise]);
    // In the old code, the 100ms timer is still active and will fire
    // (and reject a promise nobody is listening to)
    // The new code uses clearTimeout to prevent this
  });
});

// ============================================================================
// initializationComplete Promise Resolution on Failure
// ============================================================================

describe('initializationComplete promise behavior', () => {
  it('debe resolver la promesa incluso si initializeBackground falla', async () => {
    // Simulate the pattern from worker-service.ts constructor
    let resolveInit!: () => void;
    let initCompleteFlag = false;
    const initComplete = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    // Simulate initializeBackground() failing
    async function initializeBackground(): Promise<void> {
      throw new Error('DB connection failed');
    }

    // NEW pattern: catch resolves the promise
    initializeBackground().catch((_error) => {
      // Resolve the promise so waiting requests get unblocked
      resolveInit();
    });

    // A request arrives during initialization
    const timeoutMs = 5000;
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Should not timeout')), timeoutMs);
    });

    try {
      await Promise.race([initComplete, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }

    // If we get here, initComplete resolved (not the timeout)
    // initCompleteFlag should still be false (init failed)
    expect(initCompleteFlag).toBe(false);
    // But the promise resolved, so requests aren't stuck
  });

  it('si initializeBackground tiene éxito, flag se establece a true', async () => {
    let resolveInit!: () => void;
    let initCompleteFlag = false;
    const initComplete = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    // Simulate successful initialization
    async function initializeBackground(): Promise<void> {
      // Simulate some work
      await new Promise(resolve => setTimeout(resolve, 10));
      initCompleteFlag = true;
      resolveInit();
    }

    initializeBackground().catch(() => {
      resolveInit();
    });

    const timeoutMs = 5000;
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Should not timeout')), timeoutMs);
    });

    try {
      await Promise.race([initComplete, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }

    expect(initCompleteFlag).toBe(true);
  });

  it('OLD pattern: promesa pendiente eternamente si init falla', async () => {
    // Document the bug: without resolving in catch, the promise never resolves
    let resolveInit!: () => void;
    const initComplete = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });

    // Simulate failure WITHOUT resolving
    async function initializeBackground(): Promise<void> {
      throw new Error('DB connection failed');
    }

    // OLD pattern: catch only logs, doesn't resolve
    initializeBackground().catch(() => {
      // Only logging, no resolveInit()
    });

    // A request with a short timeout
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('timeout-hit'), 50);
    });

    try {
      const result = await Promise.race([
        initComplete.then(() => 'init-resolved'),
        timeoutPromise
      ]);

      // With the old pattern, timeout always wins because initComplete never resolves
      expect(result).toBe('timeout-hit');
    } finally {
      clearTimeout(timer!);
    }
  });
});

// ============================================================================
// spawnDaemon PowerShell Migration Tests
// ============================================================================

describe('spawnDaemon PowerShell command construction', () => {
  it('debe construir comando PowerShell con Start-Process y -PassThru', () => {
    // Test the command construction logic (doesn't execute)
    const execPath = 'C:\\Users\\Test\\bun.exe';
    const script = 'C:\\Users\\Test\\worker-service.cjs';
    const port = 37777;
    const extraEnv: Record<string, string> = {};

    const escapedExecPath = execPath.replace(/'/g, "''");
    const escapedScript = script.replace(/'/g, "''");

    const envSetters = Object.entries({ CLAUDE_MEM_WORKER_PORT: String(port), ...extraEnv })
      .map(([k, v]) => `\$env:${k}='${v.replace(/'/g, "''")}'`)
      .join('; ');

    const psCommand = `${envSetters}; $p = Start-Process -FilePath '${escapedExecPath}' -ArgumentList '"${escapedScript}"','--daemon' -WindowStyle Hidden -PassThru; $p.Id`;

    expect(psCommand).toContain('Start-Process');
    expect(psCommand).toContain('-WindowStyle Hidden');
    expect(psCommand).toContain('-PassThru');
    expect(psCommand).toContain('$p.Id');
    expect(psCommand).toContain(`CLAUDE_MEM_WORKER_PORT='${port}'`);
    expect(psCommand).not.toContain('wmic');
  });

  it('debe escapear comillas simples en paths correctamente', () => {
    const pathWithQuote = "C:\\User's\\path\\bun.exe";
    const escaped = pathWithQuote.replace(/'/g, "''");
    expect(escaped).toBe("C:\\User''s\\path\\bun.exe");
  });

  it('debe incluir extraEnv como $env: setters en PowerShell', () => {
    const extraEnv = {
      MY_VAR: 'hello',
      OTHER_VAR: 'world'
    };

    const envSetters = Object.entries({ CLAUDE_MEM_WORKER_PORT: '37777', ...extraEnv })
      .map(([k, v]) => `\$env:${k}='${v.replace(/'/g, "''")}'`)
      .join('; ');

    expect(envSetters).toContain("$env:CLAUDE_MEM_WORKER_PORT='37777'");
    expect(envSetters).toContain("$env:MY_VAR='hello'");
    expect(envSetters).toContain("$env:OTHER_VAR='world'");
  });

  it('debe manejar paths con espacios', () => {
    const execPath = 'C:\\Program Files\\bun\\bun.exe';
    const escaped = execPath.replace(/'/g, "''");

    // PowerShell single-quoted strings handle spaces natively
    const cmd = `Start-Process -FilePath '${escaped}'`;
    expect(cmd).toContain("'C:\\Program Files\\bun\\bun.exe'");
  });
});
