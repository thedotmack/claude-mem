#!/usr/bin/env node

/**
 * Endless Mode Metrics Analyzer
 * 
 * Analyzes worker logs to extract and report Endless Mode performance metrics:
 * - Observation creation times
 * - Compression ratios
 * - Success/failure rates
 * - Timeout occurrences
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PM2_LOG_DIR = join(homedir(), '.pm2', 'logs');
const WORKER_OUT_LOG = join(PM2_LOG_DIR, 'claude-mem-worker-out.log');
const WORKER_ERR_LOG = join(PM2_LOG_DIR, 'claude-mem-worker-error.log');
const SILENT_LOG = join(homedir(), '.claude-mem', 'silent.log');

interface ObservationMetric {
  timestamp: string;
  sessionId: number;
  toolUseId: string;
  processingTimeMs: number;
}

interface CompressionMetric {
  timestamp: string;
  toolUseId: string;
  originalSize: number;
  compressedSize: number;
  savingsPercent: number;
}

interface TimeoutMetric {
  timestamp: string;
  sessionId: number;
  toolUseId: string;
  timeoutMs: number;
}

/**
 * Parse log line and extract JSON data
 */
function parseLogLine(line: string): any | null {
  try {
    // Look for JSON in the line
    const jsonMatch = line.match(/\{[^}]+\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // Not JSON, skip
  }
  return null;
}

/**
 * Extract observation creation metrics
 */
function extractObservationMetrics(logContent: string): ObservationMetric[] {
  const metrics: ObservationMetric[] = [];
  const lines = logContent.split('\n');

  for (const line of lines) {
    if (line.includes('Observation ready (synchronous mode)')) {
      const data = parseLogLine(line);
      if (data && data.processingTimeMs) {
        metrics.push({
          timestamp: line.split(' ')[0] || new Date().toISOString(),
          sessionId: data.sessionId,
          toolUseId: data.toolUseId,
          processingTimeMs: data.processingTimeMs
        });
      }
    }
  }

  return metrics;
}

/**
 * Extract compression metrics
 */
function extractCompressionMetrics(logContent: string): CompressionMetric[] {
  const metrics: CompressionMetric[] = [];
  const lines = logContent.split('\n');

  for (const line of lines) {
    if (line.includes('Transcript transformation complete')) {
      const data = parseLogLine(line);
      if (data && data.originalSize && data.compressedSize) {
        const savings = data.savings ? parseInt(data.savings) : 
          Math.round((1 - data.compressedSize / data.originalSize) * 100);
        
        metrics.push({
          timestamp: line.split(' ')[0] || new Date().toISOString(),
          toolUseId: data.toolUseId,
          originalSize: data.originalSize,
          compressedSize: data.compressedSize,
          savingsPercent: savings
        });
      }
    }
  }

  return metrics;
}

/**
 * Extract timeout metrics
 */
function extractTimeoutMetrics(logContent: string): TimeoutMetric[] {
  const metrics: TimeoutMetric[] = [];
  const lines = logContent.split('\n');

  for (const line of lines) {
    if (line.includes('Observation timeout')) {
      const data = parseLogLine(line);
      if (data && data.tool_use_id) {
        metrics.push({
          timestamp: line.split(' ')[0] || new Date().toISOString(),
          sessionId: data.sessionId,
          toolUseId: data.tool_use_id,
          timeoutMs: data.timeoutMs || 90000
        });
      }
    }
  }

  return metrics;
}

/**
 * Calculate statistics from metrics
 */
function calculateStats(values: number[]): { min: number; max: number; avg: number; p50: number; p95: number } {
  if (values.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / values.length),
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)]
  };
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Format milliseconds to human readable
 */
function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Main analysis function
 */
function analyzeMetrics() {
  console.log('\n📊 Endless Mode Performance Metrics\n');
  console.log('═'.repeat(60));

  // Check if log files exist
  if (!existsSync(WORKER_OUT_LOG)) {
    console.error(`❌ Worker log not found: ${WORKER_OUT_LOG}`);
    console.error('   Make sure the worker is running: pm2 status');
    process.exit(1);
  }

  // Read logs
  const outLog = readFileSync(WORKER_OUT_LOG, 'utf-8');
  const errLog = existsSync(WORKER_ERR_LOG) ? readFileSync(WORKER_ERR_LOG, 'utf-8') : '';

  // Extract metrics
  const observations = extractObservationMetrics(outLog);
  const compressions = extractCompressionMetrics(outLog);
  const timeouts = extractTimeoutMetrics(outLog + errLog);

  // Display summary
  console.log(`\n📈 Summary (Last ${observations.length} observations)\n`);
  console.log(`   Observations Created: ${observations.length}`);
  console.log(`   Transcripts Compressed: ${compressions.length}`);
  console.log(`   Timeouts: ${timeouts.length}`);
  console.log(`   Success Rate: ${observations.length > 0 ? ((observations.length - timeouts.length) / observations.length * 100).toFixed(1) : 0}%`);

  // Observation creation time stats
  if (observations.length > 0) {
    console.log('\n⏱️  Observation Creation Times\n');
    const times = observations.map(o => o.processingTimeMs);
    const stats = calculateStats(times);
    
    console.log(`   Min: ${formatTime(stats.min)}`);
    console.log(`   Max: ${formatTime(stats.max)}`);
    console.log(`   Avg: ${formatTime(stats.avg)}`);
    console.log(`   P50: ${formatTime(stats.p50)}`);
    console.log(`   P95: ${formatTime(stats.p95)} ${stats.p95 < 60000 ? '✅' : '⚠️  (>60s target)'}`);
  }

  // Compression ratio stats
  if (compressions.length > 0) {
    console.log('\n🗜️  Compression Ratios\n');
    const ratios = compressions.map(c => c.savingsPercent);
    const stats = calculateStats(ratios);
    
    console.log(`   Min: ${stats.min}%`);
    console.log(`   Max: ${stats.max}%`);
    console.log(`   Avg: ${stats.avg}% ${stats.avg >= 80 ? '✅' : '⚠️  (<80% target)'}`);
    console.log(`   P50: ${stats.p50}%`);
    console.log(`   P95: ${stats.p95}%`);

    // Size reduction stats
    const originalSizes = compressions.map(c => c.originalSize);
    const compressedSizes = compressions.map(c => c.compressedSize);
    const origStats = calculateStats(originalSizes);
    const compStats = calculateStats(compressedSizes);

    console.log('\n📦 Size Reduction\n');
    console.log(`   Original (avg): ${formatBytes(origStats.avg)}`);
    console.log(`   Compressed (avg): ${formatBytes(compStats.avg)}`);
    console.log(`   Saved (avg): ${formatBytes(origStats.avg - compStats.avg)}`);
  }

  // Timeout details
  if (timeouts.length > 0) {
    console.log('\n⏰ Timeouts\n');
    timeouts.slice(-5).forEach(t => {
      console.log(`   ${t.timestamp} - Session ${t.sessionId} - ${t.toolUseId.substring(0, 20)}...`);
    });
  }

  // Recent activity (last 10 observations)
  if (observations.length > 0) {
    console.log('\n📋 Recent Activity (Last 10)\n');
    observations.slice(-10).forEach(o => {
      const compression = compressions.find(c => c.toolUseId === o.toolUseId);
      const compressionStr = compression ? ` - ${compression.savingsPercent}% compression` : '';
      console.log(`   ${o.timestamp} - ${formatTime(o.processingTimeMs)}${compressionStr}`);
    });
  }

  // Health check
  console.log('\n🏥 Health Check\n');
  const avgCreationTime = observations.length > 0 ? calculateStats(observations.map(o => o.processingTimeMs)).avg : 0;
  const avgCompression = compressions.length > 0 ? calculateStats(compressions.map(c => c.savingsPercent)).avg : 0;
  const timeoutRate = observations.length > 0 ? (timeouts.length / observations.length * 100) : 0;

  console.log(`   Avg Creation Time: ${formatTime(avgCreationTime)} ${avgCreationTime < 60000 ? '✅' : '⚠️'}`);
  console.log(`   Avg Compression: ${avgCompression}% ${avgCompression >= 80 ? '✅' : '⚠️'}`);
  console.log(`   Timeout Rate: ${timeoutRate.toFixed(1)}% ${timeoutRate < 5 ? '✅' : '⚠️'}`);

  // Overall status
  const allGood = avgCreationTime < 60000 && avgCompression >= 80 && timeoutRate < 5;
  console.log('\n' + '═'.repeat(60));
  console.log(`\n${allGood ? '✅ All metrics within target' : '⚠️  Some metrics need attention'}\n`);

  // Recommendations
  if (!allGood) {
    console.log('💡 Recommendations:\n');
    if (avgCreationTime >= 60000) {
      console.log('   - Consider optimizing SDK Agent processing');
      console.log('   - Check if model API is slow');
    }
    if (avgCompression < 80) {
      console.log('   - Review compression prompts in SDKAgent');
      console.log('   - Check tool output types being compressed');
    }
    if (timeoutRate >= 5) {
      console.log('   - Increase timeout threshold if needed');
      console.log('   - Investigate specific timeout cases');
    }
    console.log('');
  }
}

// Run analysis
try {
  analyzeMetrics();
} catch (error) {
  console.error('\n❌ Error analyzing metrics:', error);
  process.exit(1);
}
