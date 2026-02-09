/**
 * Memory Services Benchmark Script
 *
 * 測試 P0-P2 新記憶服務的效能和效益
 *
 * Usage:
 *   npm run benchmark:memory
 *   bun run benchmark/memory-services.bench.ts
 */

import { performance } from 'perf_hooks';

// ============================================
// Configuration
// ============================================

const CONFIG = {
  baseUrl: 'http://localhost:37777',
  iterations: 100,
  warmupIterations: 10,
  testQueries: [
    'memory service',
    'search implementation',
    'API endpoint',
    'database schema',
    'migration',
    'observation processing',
    'session management',
    'context generation',
  ],
};

// ============================================
// Benchmark Framework
// ============================================

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  throughput: number;
}

class Benchmark {
  private results: Map<string, number[]> = new Map();

  async measure(name: string, fn: () => Promise<any>): Promise<number> {
    const start = performance.now();
    await fn();
    const elapsed = performance.now() - start;

    if (!this.results.has(name)) {
      this.results.set(name, []);
    }
    this.results.get(name)!.push(elapsed);

    return elapsed;
  }

  async run(
    name: string,
    fn: () => Promise<any>,
    options: { iterations: number; warmup?: number } = { iterations: 10 }
  ): Promise<BenchmarkResult> {
    const { iterations, warmup = 0 } = options;

    // Warmup
    for (let i = 0; i < warmup; i++) {
      await fn();
    }

    // Actual benchmark
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
    }

    const totalTime = times.reduce((a, b) => a + b, 0);
    const avgTime = totalTime / iterations;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const throughput = iterations / (totalTime / 1000);

    return {
      name,
      iterations,
      totalTime,
      avgTime,
      minTime,
      maxTime,
      throughput,
    };
  }

  compare(baseline: BenchmarkResult, comparison: BenchmarkResult): string {
    const improvement = ((baseline.avgTime - comparison.avgTime) / baseline.avgTime) * 100;
    const speedup = baseline.avgTime / comparison.avgTime;

    return `
${'='.repeat(60)}
Comparison: ${baseline.name} vs ${comparison.name}
${'='.repeat(60)}
${baseline.name.padEnd(30)}: ${baseline.avgTime.toFixed(2)}ms avg
${comparison.name.padEnd(30)}: ${comparison.avgTime.toFixed(2)}ms avg
${'-'.repeat(60)}
Improvement: ${improvement > 0 ? '+' : ''}${improvement.toFixed(2)}%
Speedup:    ${speedup.toFixed(2)}x
${'='.repeat(60)}
`;
  }

  summary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('BENCHMARK SUMMARY');
    console.log('='.repeat(60));

    for (const [name, times] of this.results.entries()) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);
      console.log(`${name.padEnd(40)}: avg=${avg.toFixed(2)}ms min=${min.toFixed(2)}ms max=${max.toFixed(2)}ms n=${times.length}`);
    }

    console.log('='.repeat(60) + '\n');
  }
}

// ============================================
// HTTP Helpers
// ============================================

async function httpGet(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function httpPost(url: string, data: any): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function httpPut(url: string, data: any): Promise<any> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function httpDeleteSafe(url: string): Promise<void> {
  try {
    await httpDelete(url);
  } catch (error: any) {
    // Ignore 404 errors (cube doesn't exist yet)
    if (!error.message?.includes('404')) {
      throw error;
    }
  }
}

// ============================================
// P1: Working Memory Benchmarks
// ============================================

async function benchmarkWorkingMemory(bench: Benchmark): Promise<void> {
  console.log('\n📊 P1: Working Memory Benchmarks\n');

  // Setup: Clear working memory before test
  await httpPost(`${CONFIG.baseUrl}/api/memory/working/clear`, {});

  // Test 1: First query (cache miss)
  const firstQuery = await bench.run(
    'First Query (Cache Miss)',
    async () => {
      await httpGet(`${CONFIG.baseUrl}/api/search?query=${encodeURIComponent(CONFIG.testQueries[0])}`);
    },
    { iterations: 20, warmup: 0 }
  );
  console.log(`  First Query (Cache Miss): ${firstQuery.avgTime.toFixed(2)}ms avg`);

  // Test 2: Repeated query (cache hit)
  const cachedQuery = await bench.run(
    'Repeated Query (Cache Hit)',
    async () => {
      await httpGet(`${CONFIG.baseUrl}/api/search?query=${encodeURIComponent(CONFIG.testQueries[0])}`);
    },
    { iterations: 50, warmup: 10 }
  );
  console.log(`  Repeated Query (Cache Hit): ${cachedQuery.avgTime.toFixed(2)}ms avg`);

  // Test 3: Diverse queries (mixed cache)
  const diverseQueries = await bench.run(
    'Diverse Queries (Mixed Cache)',
    async () => {
      const query = CONFIG.testQueries[Math.floor(Math.random() * CONFIG.testQueries.length)];
      await httpGet(`${CONFIG.baseUrl}/api/search?query=${encodeURIComponent(query)}`);
    },
    { iterations: 100, warmup: 20 }
  );
  console.log(`  Diverse Queries (Mixed Cache): ${diverseQueries.avgTime.toFixed(2)}ms avg`);

  // Test 4: Working Memory stats
  const stats = await httpGet(`${CONFIG.baseUrl}/api/memory/working/stats`);
  console.log(`\n  Working Memory Stats:`);
  console.log(`    Size: ${stats.stats.size}`);
  console.log(`    Capacity: ${stats.stats.capacity}`);
  console.log(`    Utilization: ${stats.stats.utilizationPercent}%`);

  // Calculate cache effectiveness
  const cacheSpeedup = firstQuery.avgTime / cachedQuery.avgTime;
  const cacheImprovement = ((firstQuery.avgTime - cachedQuery.avgTime) / firstQuery.avgTime) * 100;

  console.log(`\n  📈 Cache Effectiveness:`);
  console.log(`    Speedup: ${cacheSpeedup.toFixed(2)}x`);
  console.log(`    Improvement: ${cacheImprovement.toFixed(2)}%`);

  console.log(bench.compare(firstQuery, cachedQuery));
}

// ============================================
// P2: Memory Cube Benchmarks
// ============================================

async function benchmarkMemoryCubes(bench: Benchmark): Promise<void> {
  console.log('\n📊 P2: Memory Cube Benchmarks\n');

  // Test 1: Create cube (with unique ID)
  const createCube = await bench.run(
    'Create Cube',
    async () => {
      const uniqueId = `benchmark-cube-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await httpPost(`${CONFIG.baseUrl}/api/memory/cubes`, {
        cubeId: uniqueId,
        name: 'Benchmark Cube',
        description: 'Performance test cube',
      });
    },
    { iterations: 20, warmup: 0 }
  );
  console.log(`  Create Cube: ${createCube.avgTime.toFixed(2)}ms avg`);

  // Test 2: List cubes
  const listCubes = await bench.run(
    'List Cubes',
    async () => {
      await httpGet(`${CONFIG.baseUrl}/api/memory/cubes`);
    },
    { iterations: 50 }
  );
  console.log(`  List Cubes: ${listCubes.avgTime.toFixed(2)}ms avg`);

  // Test 3: Get cube stats (create a test cube first)
  let testCubeId = '';
  const testCube = await httpPost(`${CONFIG.baseUrl}/api/memory/cubes`, {
    cubeId: `benchmark-test-${Date.now()}`,
    name: 'Test Cube',
    description: 'For stats test',
  });
  testCubeId = testCube.cubeId;

  const cubeStats = await bench.run(
    'Get Cube Stats',
    async () => {
      await httpGet(`${CONFIG.baseUrl}/api/memory/cubes/${testCubeId}`);
    },
    { iterations: 50 }
  );
  console.log(`  Get Cube Stats: ${cubeStats.avgTime.toFixed(2)}ms avg`);

  // Test 4: Export cube
  const exportCube = await bench.run(
    'Export Cube',
    async () => {
      await httpPost(`${CONFIG.baseUrl}/api/memory/cubes/${testCubeId}/export`, {
        exportPath: `/tmp/${testCubeId}-export.json`,
      });
    },
    { iterations: 10 }
  );
  console.log(`  Export Cube: ${exportCube.avgTime.toFixed(2)}ms avg`);

  // Test 5: Set active cube
  const setActiveCube = await bench.run(
    'Set Active Cube',
    async () => {
      await httpPost(`${CONFIG.baseUrl}/api/memory/cubes/${testCubeId}/set-active`, {});
    },
    { iterations: 30 }
  );
  console.log(`  Set Active Cube: ${setActiveCube.avgTime.toFixed(2)}ms avg`);

  // Test 6: Get active cube
  const getActiveCube = await bench.run(
    'Get Active Cube',
    async () => {
      await httpGet(`${CONFIG.baseUrl}/api/memory/cubes/active`);
    },
    { iterations: 50 }
  );
  console.log(`  Get Active Cube: ${getActiveCube.avgTime.toFixed(2)}ms avg`);

  // Cleanup
  await httpDelete(`${CONFIG.baseUrl}/api/memory/cubes/${testCubeId}`);
}

async function httpDelete(url: string): Promise<any> {
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.status === 204 ? null : response.json();
}

// ============================================
// P0: Memory Feedback Benchmarks
// ============================================

async function benchmarkMemoryFeedback(bench: Benchmark): Promise<void> {
  console.log('\n📊 P0: Memory Feedback Benchmarks\n');

  // Test 1: Submit feedback
  const submitFeedback = await bench.run(
    'Submit Feedback',
    async () => {
      await httpPost(`${CONFIG.baseUrl}/api/memory/feedback`, {
        feedback: '專案名稱應該是 claude-mem 不是 claudemem',
        memorySessionId: 'benchmark-session',
        project: 'claude-mem',
      });
    },
    { iterations: 20 }
  );
  console.log(`  Submit Feedback: ${submitFeedback.avgTime.toFixed(2)}ms avg`);

  // Test 2: Get feedback config
  const getFeedbackConfig = await bench.run(
    'Get Feedback Config',
    async () => {
      await httpGet(`${CONFIG.baseUrl}/api/memory/feedback/config`);
    },
    { iterations: 50 }
  );
  console.log(`  Get Feedback Config: ${getFeedbackConfig.avgTime.toFixed(2)}ms avg`);

  // Test 3: Update feedback config
  const updateFeedbackConfig = await bench.run(
    'Update Feedback Config',
    async () => {
      await httpPut(`${CONFIG.baseUrl}/api/memory/feedback/config`, {
        confidenceThreshold: 0.8,
      });
    },
    { iterations: 30 }
  );
  console.log(`  Update Feedback Config: ${updateFeedbackConfig.avgTime.toFixed(2)}ms avg`);

  // Reset config
  await httpPut(`${CONFIG.baseUrl}/api/memory/feedback/config`, {
    confidenceThreshold: 0.7,
  });
}

// ============================================
// Search Performance Comparison
// ============================================

async function benchmarkSearchPerformance(bench: Benchmark): Promise<void> {
  console.log('\n📊 Search Performance Comparison\n');

  // Clear working memory for clean test
  await httpPost(`${CONFIG.baseUrl}/api/memory/working/clear`, {});

  // Test 1: Cold search (no cache)
  const coldSearch = await bench.run(
    'Cold Search (No Cache)',
    async () => {
      const query = CONFIG.testQueries[Math.floor(Math.random() * CONFIG.testQueries.length)];
      await httpGet(`${CONFIG.baseUrl}/api/search?query=${encodeURIComponent(query)}`);
    },
    { iterations: 20, warmup: 0 }
  );
  console.log(`  Cold Search (No Cache): ${coldSearch.avgTime.toFixed(2)}ms avg`);

  // Test 2: Warm search (with cache)
  const warmSearch = await bench.run(
    'Warm Search (With Cache)',
    async () => {
      const query = CONFIG.testQueries[Math.floor(Math.random() * CONFIG.testQueries.length)];
      await httpGet(`${CONFIG.baseUrl}/api/search?query=${encodeURIComponent(query)}`);
    },
    { iterations: 50, warmup: 20 }
  );
  console.log(`  Warm Search (With Cache): ${warmSearch.avgTime.toFixed(2)}ms avg`);

  console.log(bench.compare(coldSearch, warmSearch));

  // Get final stats
  const stats = await httpGet(`${CONFIG.baseUrl}/api/memory/working/stats`);
  console.log(`\n  Final Working Memory Stats:`);
  console.log(`    Size: ${stats.stats.size}/${stats.stats.capacity}`);
  console.log(`    Utilization: ${stats.stats.utilizationPercent}%`);
  console.log(`    Top Accessed: ${JSON.stringify(stats.stats.topAccessed).slice(0, 100)}...`);
}

// ============================================
// Main Benchmark Runner
// ============================================

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Memory Services (P0-P2) Performance Benchmark         ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nConfiguration:`);
  console.log(`  Base URL: ${CONFIG.baseUrl}`);
  console.log(`  Iterations: ${CONFIG.iterations}`);
  console.log(`  Test Queries: ${CONFIG.testQueries.length}`);

  const bench = new Benchmark();

  try {
    // Check worker is running
    await httpGet(`${CONFIG.baseUrl}/api/health`);

    // Run benchmarks
    await benchmarkSearchPerformance(bench);
    await benchmarkWorkingMemory(bench);
    await benchmarkMemoryCubes(bench);
    await benchmarkMemoryFeedback(bench);

    // Print summary
    bench.summary();

  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    console.error('\nMake sure the worker is running:');
    console.error('  npm run worker:restart');
    process.exit(1);
  }
}

// Run if executed directly
main();
