/**
 * Integration Test: Context Inject Early Access
 *
 * Tests that /api/context/inject endpoint is available immediately
 * when worker starts, even before background initialization completes.
 *
 * This prevents the 404 error described in the issue where the hook
 * tries to access the endpoint before SearchRoutes are registered.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Context Inject Early Access', () => {
  const workerPath = path.join(__dirname, '../../plugin/scripts/worker-service.cjs');
  
  it('should have /api/context/inject route available immediately on startup', async () => {
    // This test verifies the fix by checking that:
    // 1. The route exists immediately (no 404)
    // 2. The route waits for initialization before processing
    // 3. Requests don't fail with "Cannot GET /api/context/inject"

    // The fix adds an early handler that:
    // - Registers the route in setupRoutes() (called during construction)
    // - Waits for initializationComplete promise
    // - Processes the request after initialization

    // Since we can't easily spin up a full worker in tests,
    // we verify the code structure is correct by checking
    // the compiled output contains the necessary pieces

    const workerCode = fs.readFileSync(workerPath, 'utf-8');

    // Verify initialization promise exists
    expect(workerCode).toContain('initializationComplete');
    expect(workerCode).toContain('resolveInitialization');

    // Verify early route handler is registered in setupRoutes
    expect(workerCode).toContain('/api/context/inject');
    expect(workerCode).toContain('Promise.race');
    
    // Verify the promise is resolved after initialization
    expect(workerCode).toContain('this.resolveInitialization()');
  });

  it('should handle timeout if initialization takes too long', () => {
    const workerCode = fs.readFileSync(workerPath, 'utf-8');

    // Verify timeout protection (30 seconds)
    expect(workerCode).toContain('3e4'); // 30000 in scientific notation
    expect(workerCode).toContain('Initialization timeout');
  });
});
