import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  applyShadowPatch,
  appendRulesReport,
  detectClockHeader,
  detectDenyAllow,
  detectDrift,
  detectShadowHouse,
  formatReportSection,
  gatherLayerEntries,
  isSafePatchTarget,
  readFileLines,
  rulesReportPath,
  walkRules,
  type RulesConflict,
  type RulesWalkerConfig,
} from '../../src/services/integrations/CcsAlignRulesWalker.js';

const VIEWER = 'ccs-align';
const now = new Date('2026-09-09T18:00:00.000Z');

describe('CCS Align Phase 2 — rules walker', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ccs-align-rules-'));
    temps.push(dir);
    return dir;
  }

  function writeFile(root: string, relPath: string, content: string): string {
    const full = path.join(root, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    return full;
  }

  // --- Fixture: duplicated "House rule" → SHADOW_HOUSE in report ---

  it('detects SHADOW_HOUSE when a leaf file duplicates a house line', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/profile.txt', [
      'Always address the human as Alex.',
      'Never delete observation history.',
      'Timestamps belong on facts, not headers.',
    ].join('\n'));

    const seatPath = writeFile(root, 'seat/agent-1/rules.md', [
      'Always address the human as Alex.',
      'Some agent-specific rule here.',
      'Never delete observation history.',
    ].join('\n'));

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    const shadows = result.conflicts.filter(c => c.code === 'SHADOW_HOUSE');
    expect(shadows.length).toBeGreaterThanOrEqual(2);
    expect(shadows.some(c => c.line.includes('Always address the human as Alex.'))).toBe(true);
    expect(shadows.some(c => c.line.includes('Never delete observation history.'))).toBe(true);
  });

  it('detects SHADOW_HOUSE when a leaf line starts with "House rule"', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/shared.md', 'Do not write profile.md from Align.');

    const seatPath = writeFile(root, 'seat/agent-1/config.md', [
      'House rule: do not write profile.md from Align.',
      'Another local rule.',
    ].join('\n'));

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    const shadows = result.conflicts.filter(c => c.code === 'SHADOW_HOUSE');
    expect(shadows.length).toBeGreaterThanOrEqual(1);
    expect(shadows[0].line).toContain('House rule');
  });

  // --- Default settings leave leaf unchanged ---

  it('default settings (patchShadows=false) leave the leaf file unchanged', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/rules.md', 'Never delete observation history.');

    const seatContent = 'Never delete observation history.\nSome other rule.';
    const seatPath = writeFile(root, 'seat/agent-1/rules.md', seatContent);

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    expect(result.patchesApplied).toBe(0);

    const afterContent = readFileSync(seatPath, 'utf8');
    expect(afterContent).toBe(seatContent);
  });

  // --- With patch flag on, leaf loses only duplicates; house unchanged ---

  it('with patchShadows=true, leaf loses only duplicate lines and house is unchanged', () => {
    const root = tempRoot();
    const houseContent = 'Always address the human as Alex.\nNever delete observation history.';
    const housePath = writeFile(root, 'house/rules.md', houseContent);

    const seatContent = [
      'Always address the human as Alex.',
      'Some agent-specific rule.',
      'Never delete observation history.',
      'Another agent rule.',
    ].join('\n');
    const seatPath = writeFile(root, 'seat/agent-1/rules.md', seatContent);

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: true,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    expect(result.patchesApplied).toBe(2);

    const patchedContent = readFileSync(seatPath, 'utf8');
    expect(patchedContent).not.toContain('Always address the human as Alex.');
    expect(patchedContent).not.toContain('Never delete observation history.');
    expect(patchedContent).toContain('Some agent-specific rule.');
    expect(patchedContent).toContain('Another agent rule.');

    const houseAfter = readFileSync(housePath, 'utf8');
    expect(houseAfter).toBe(houseContent);
  });

  // --- No write to standing / always.md / never.md ---

  it('never patches standing, always.md, or never.md even when patchShadows=true', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/rules.md', 'House shared rule.');

    const standingContent = 'House shared rule.\nStanding order.';
    const standingPath = writeFile(root, 'seat/standing.md', standingContent);
    const alwaysContent = 'House shared rule.\nAlways do X.';
    const alwaysPath = writeFile(root, 'seat/always.md', alwaysContent);
    const neverContent = 'House shared rule.\nNever do Y.';
    const neverPath = writeFile(root, 'seat/never.md', neverContent);

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: true,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [standingPath, alwaysPath, neverPath],
    };

    walkRules(config, now);

    expect(readFileSync(standingPath, 'utf8')).toBe(standingContent);
    expect(readFileSync(alwaysPath, 'utf8')).toBe(alwaysContent);
    expect(readFileSync(neverPath, 'utf8')).toBe(neverContent);
  });

  // --- MISS on box with no agent-data tree ---

  it('on a box with no agent-data tree, report says MISS and exits 0', () => {
    const root = tempRoot();
    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [path.join(root, 'nonexistent', 'house')],
      projectPaths: [path.join(root, 'nonexistent', 'project')],
      seatPaths: [path.join(root, 'nonexistent', 'seat')],
    };

    const result = walkRules(config, now);
    expect(result.conflicts).toHaveLength(0);
    expect(result.misses.length).toBeGreaterThan(0);
    expect(result.misses.some(m => m.includes('house-box paths'))).toBe(true);

    const reportContent = readFileSync(result.reportPath, 'utf8');
    expect(reportContent).toContain('MISS');
  });

  // --- CLOCK_HEADER detection ---

  it('detects CLOCK_HEADER in profile files', () => {
    expect(detectClockHeader('# Current time is 2026-09-09T18:00:00Z')).toBe(true);
    expect(detectClockHeader('Current date is 2026-09-09')).toBe(true);
    expect(detectClockHeader('Today is: 2026-09-09')).toBe(true);
    expect(detectClockHeader('current time is now')).toBe(true);
    expect(detectClockHeader('Some normal rule about time management')).toBe(false);
    expect(detectClockHeader('Remember to check the time')).toBe(false);
  });

  it('reports CLOCK_HEADER conflicts from walkRules', () => {
    const root = tempRoot();
    const seatPath = writeFile(root, 'seat/agent-1/profile.md', [
      '# Current time is 2026-09-09T18:00:00Z',
      'Some other rule.',
    ].join('\n'));

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    const clockHeaders = result.conflicts.filter(c => c.code === 'CLOCK_HEADER');
    expect(clockHeaders.length).toBeGreaterThanOrEqual(1);
  });

  // --- DENY_ALLOW detection ---

  it('detects DENY_ALLOW when same bucket has allow at one layer and deny at another', () => {
    const result = detectDenyAllow('allow reading obs bucket', [
      'deny reading obs bucket',
      'some unrelated rule',
    ]);
    expect(result.isDenyAllow).toBe(true);
    expect(result.detail).toContain('deny/allow');
  });

  it('does not flag DENY_ALLOW when no conflict exists', () => {
    const result = detectDenyAllow('some rule about foo', ['another rule about bar']);
    expect(result.isDenyAllow).toBe(false);
  });

  // --- DRIFT detection ---

  it('detects DRIFT when leaf has old wording that partially matches house', () => {
    const result = detectDrift(
      'Always address the human as Alexander.',
      ['Always address the human as Alex.'],
      0.7,
    );
    expect(result.isDrift).toBe(true);
    expect(result.matchedHouseLine).toBe('Always address the human as Alex.');
  });

  it('does not flag DRIFT on exact matches (those are SHADOW_HOUSE)', () => {
    const result = detectDrift(
      'Always address the human as Alex.',
      ['Always address the human as Alex.'],
      0.7,
    );
    expect(result.isDrift).toBe(false);
  });

  // --- Report generation ---

  it('generates a dated, append-only rules report', () => {
    const root = tempRoot();
    const reportFile = rulesReportPath(root, VIEWER);
    const conflicts: RulesConflict[] = [
      {
        code: 'SHADOW_HOUSE',
        layer: 'seat',
        file: '/some/path/rules.md',
        line: 'Always address the human as Alex.',
        detail: 'Leaf duplicates house line: "Always address the human as Alex."',
      },
    ];

    appendRulesReport(reportFile, formatReportSection(now, conflicts, [], 0));
    const content = readFileSync(reportFile, 'utf8');
    expect(content).toContain('CCS Align — Rules Report');
    expect(content).toContain('2026-09-09 18:00:00');
    expect(content).toContain('SHADOW_HOUSE');
    expect(content).toContain('Prioritizer');

    // Append a second section — the file should grow, not overwrite
    const later = new Date('2026-09-10T06:00:00.000Z');
    appendRulesReport(reportFile, formatReportSection(later, [], ['house-box paths'], 0));
    const content2 = readFileSync(reportFile, 'utf8');
    expect(content2).toContain('2026-09-09 18:00:00');
    expect(content2).toContain('2026-09-10 06:00:00');
    expect(content2).toContain('MISS: house-box paths');
  });

  // --- isSafePatchTarget ---

  it('refuses to patch standing.md, always.md, never.md, danger.md, and profile.md', () => {
    expect(isSafePatchTarget('/foo/standing.md')).toBe(false);
    expect(isSafePatchTarget('/foo/always.md')).toBe(false);
    expect(isSafePatchTarget('/foo/never.md')).toBe(false);
    expect(isSafePatchTarget('/foo/danger.md')).toBe(false);
    expect(isSafePatchTarget('/foo/profile.md')).toBe(false);
    expect(isSafePatchTarget('/foo/focus/bar.md')).toBe(false);
    expect(isSafePatchTarget('/foo/rules.md')).toBe(true);
    expect(isSafePatchTarget('/foo/config.md')).toBe(true);
  });

  // --- applyShadowPatch ---

  it('removes only specified duplicate lines from a leaf file atomically', () => {
    const root = tempRoot();
    const content = 'Line A\nLine B\nLine C\nLine D\n';
    const filePath = writeFile(root, 'leaf.md', content);

    const removed = applyShadowPatch(filePath, new Set(['Line B', 'Line D']));
    expect(removed).toBe(2);

    const result = readFileSync(filePath, 'utf8');
    expect(result).toContain('Line A');
    expect(result).toContain('Line C');
    expect(result).not.toContain('Line B');
    expect(result).not.toContain('Line D');
  });

  it('returns 0 and does not touch the file when no lines match', () => {
    const root = tempRoot();
    const content = 'Line A\nLine B\n';
    const filePath = writeFile(root, 'leaf.md', content);

    const removed = applyShadowPatch(filePath, new Set(['Line X']));
    expect(removed).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe(content);
  });

  // --- readFileLines ---

  it('reads non-empty trimmed lines from a file', () => {
    const root = tempRoot();
    const filePath = writeFile(root, 'test.txt', 'Line 1\n\n  Line 2  \nLine 3\n');
    const lines = readFileLines(filePath);
    expect(lines).toEqual(['Line 1', '  Line 2', 'Line 3']);
  });

  it('returns empty array for missing files', () => {
    expect(readFileLines('/nonexistent/path')).toEqual([]);
  });

  // --- gatherLayerEntries ---

  it('gathers files from a directory recursively and records misses', () => {
    const root = tempRoot();
    writeFile(root, 'layer/a.md', 'rule A');
    writeFile(root, 'layer/sub/b.md', 'rule B');

    const { entries, misses } = gatherLayerEntries([path.join(root, 'layer')], 'house');
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.found)).toBe(true);
    expect(misses).toHaveLength(0);
  });

  it('records misses for non-existent paths', () => {
    const { entries, misses } = gatherLayerEntries(['/nonexistent/path'], 'house');
    expect(entries).toHaveLength(0);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toContain('house');
  });

  // --- detectShadowHouse ---

  it('detects exact duplicate lines as SHADOW_HOUSE', () => {
    const houseLines = new Set(['Always be kind.', 'Never lie.']);
    expect(detectShadowHouse('Always be kind.', houseLines).isShadow).toBe(true);
    expect(detectShadowHouse('Something else.', houseLines).isShadow).toBe(false);
  });

  it('detects "House rule:" prefix as SHADOW_HOUSE', () => {
    const houseLines = new Set(['Never lie.']);
    const result = detectShadowHouse('House rule: Never lie.', houseLines);
    expect(result.isShadow).toBe(true);
  });

  // --- Full integration: walkRules end-to-end ---

  it('walkRules produces a complete report with all conflict types', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/shared.md', [
      'Always address the human as Alex.',
      'allow reading profile bucket',
    ].join('\n'));

    const seatPath = writeFile(root, 'seat/agent/rules.md', [
      'Always address the human as Alex.',
      'House rule: some old copy',
      '# Current time is 2026-01-01',
      'deny reading profile bucket',
    ].join('\n'));

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    const codes = result.conflicts.map(c => c.code);
    expect(codes).toContain('SHADOW_HOUSE');
    expect(codes).toContain('CLOCK_HEADER');
    expect(codes).toContain('DENY_ALLOW');

    expect(existsSync(result.reportPath)).toBe(true);
    const report = readFileSync(result.reportPath, 'utf8');
    expect(report).toContain('SHADOW_HOUSE');
    expect(report).toContain('CLOCK_HEADER');
    expect(report).toContain('DENY_ALLOW');
  });

  it('walkRules with patchShadows writes diff into report then patches', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/rules.md', 'Shared house rule.');
    const seatContent = 'Shared house rule.\nLocal seat rule.';
    const seatPath = writeFile(root, 'seat/agent/rules.md', seatContent);

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: true,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    expect(result.patchesApplied).toBe(1);

    const patched = readFileSync(seatPath, 'utf8');
    expect(patched).not.toContain('Shared house rule.');
    expect(patched).toContain('Local seat rule.');

    const report = readFileSync(result.reportPath, 'utf8');
    expect(report).toContain('SHADOW_HOUSE');
    expect(report).toContain('Patches applied: 1');
  });

  // --- Edge cases ---

  it('handles empty layer paths gracefully', () => {
    const root = tempRoot();
    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [],
      projectPaths: [],
      seatPaths: [],
    };

    const result = walkRules(config, now);
    expect(result.conflicts).toHaveLength(0);
    expect(result.misses).toHaveLength(0);
    expect(existsSync(result.reportPath)).toBe(true);
  });

  it('handles files with only empty lines', () => {
    const root = tempRoot();
    const housePath = writeFile(root, 'house/empty.md', '\n\n\n');
    const seatPath = writeFile(root, 'seat/empty.md', '\n\n\n');

    const config: RulesWalkerConfig = {
      dataRoot: root,
      viewerId: VIEWER,
      patchShadows: false,
      housePaths: [housePath],
      projectPaths: [],
      seatPaths: [seatPath],
    };

    const result = walkRules(config, now);
    expect(result.conflicts).toHaveLength(0);
  });
});
