import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

// CCS Align — Phase 2: rules alignment (house → project → seat).
//
// A periodic walk over house, project, and seat layers to detect conflicts and
// priority drift. Output is an append-only `rules-report.md`. Limited patch
// agency on SHADOW_HOUSE only, gated by CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS.
//
// This is a CHECKLIST, not a parser. Fail closed; deny beats allow; write-once
// at HOUSE; leaf copy shadows. The .cas compiler is NOT shipped here.
//
// Cascade rules (from Notion CCS, plan §2.1):
//   - Write once at HOUSE; seats inherit
//   - A leaf copy SHADOWS the cascade (bug, not feature)
//   - Deny beats allow
//   - Siblings deny heavy buckets (obs, note, person) by default
//
// Hard constraints:
//   - Never write profile.md, user-memory, or project memory
//   - Never patch standing / Focus / always.md / never.md
//   - Never "fix" deny/allow by flipping rules
//   - Never copy house text into seats (that is the bug)
//   - On a box with no agent-data tree: report MISS and exit 0

const CCS_ALIGN_DIRNAME = 'ccs-align';
const RULES_REPORT_FILENAME = 'rules-report.md';

// Conflict class codes (v1 only — do not invent more)
export type ConflictCode = 'SHADOW_HOUSE' | 'DENY_ALLOW' | 'DRIFT' | 'CLOCK_HEADER';

export interface RulesConflict {
  code: ConflictCode;
  layer: 'house' | 'project' | 'seat';
  file: string;
  line: string;
  detail: string;
  /** The matching house line, if applicable. */
  houseMatch?: string;
}

export interface LayerEntry {
  layer: 'house' | 'project' | 'seat';
  file: string;
  lines: string[];
  /** True if the file was found; false for a MISS. */
  found: boolean;
}

export interface RulesWalkResult {
  conflicts: RulesConflict[];
  layers: LayerEntry[];
  misses: string[];
  reportPath: string;
  patchesApplied: number;
}

export interface RulesWalkerConfig {
  dataRoot: string;
  viewerId: string;
  patchShadows: boolean;
  /** House-layer paths to check (user-memory shared profile, etc.). */
  housePaths: string[];
  /** Project-layer paths (.cmem-projects/<project>/, repo CLAUDE.md). */
  projectPaths: string[];
  /** Seat-layer paths (agents/<uuid>/profile.md, agents/<uuid>/memory/). */
  seatPaths: string[];
}

// Forbidden patch targets: standing, Focus, always/never/danger files.
const FORBIDDEN_PATCH_BASENAMES = new Set([
  'standing.md',
  'always.md',
  'never.md',
  'danger.md',
]);

const FORBIDDEN_PATCH_PATH_PATTERNS = [
  /standing/i,
  /(^|[\\/])focus([\\/]|$)/i,
];

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

export function loadRulesWalkerConfig(
  settingsPath: string = USER_SETTINGS_PATH,
  env: NodeJS.ProcessEnv = process.env,
): RulesWalkerConfig {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  const dataRoot = env.CLAUDE_MEM_DATA_DIR
    ? env.CLAUDE_MEM_DATA_DIR
    : (settings.CLAUDE_MEM_DATA_DIR || path.join(homedir(), '.claude-mem'));

  const patchShadows = (
    env.CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS ??
    settings.CLAUDE_MEM_CCS_ALIGN_PATCH_SHADOWS ??
    'false'
  ) === 'true';

  const viewerIds = splitCsv(settings.CLAUDE_MEM_CCS_ALIGN_VIEWER_IDS);
  const viewerId = viewerIds[0] || 'ccs-align';

  return {
    dataRoot,
    viewerId,
    patchShadows,
    housePaths: [],
    projectPaths: [],
    seatPaths: [],
  };
}

export function rulesReportPath(dataRoot: string, viewerId: string): string {
  return path.join(dataRoot, CCS_ALIGN_DIRNAME, viewerId, RULES_REPORT_FILENAME);
}

/**
 * Read all non-empty trimmed lines from a file. Returns empty array if the
 * file does not exist or cannot be read.
 */
export function readFileLines(filePath: string): string[] {
  try {
    if (!existsSync(filePath)) return [];
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .map(l => l.trimEnd())
      .filter(l => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Collect all readable files under a directory, recursively. Returns absolute
 * paths. Silently returns empty if the dir is missing.
 */
function collectFiles(dirPath: string): string[] {
  const result: string[] = [];
  if (!existsSync(dirPath)) return result;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        result.push(...collectFiles(full));
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  } catch { /* unreadable dir */ }
  return result;
}

/**
 * Detect CLOCK_HEADER: a top-of-prompt clock or "current time is" line in a
 * profile. House rule says timestamps belong on facts, not as a header.
 */
export function detectClockHeader(line: string): boolean {
  const lower = line.toLowerCase();
  const trimmed = line.trim();
  return (
    /^(#\s*)?current (time|date|datetime)\b/i.test(trimmed) ||
    lower.includes('current time is') ||
    lower.includes('current date is') ||
    /^(#\s*)?(today|now)\s*(is\s*:|:\s*)\s*\d{4}/i.test(trimmed)
  );
}

/**
 * Detect whether a leaf line shadows a house line (SHADOW_HOUSE).
 * A match is: exact duplicate, or the leaf line starts with "House rule".
 */
export function detectShadowHouse(
  leafLine: string,
  houseLines: Set<string>,
): { isShadow: boolean; matchedHouseLine?: string } {
  const trimmed = leafLine.trim();
  if (houseLines.has(trimmed)) {
    return { isShadow: true, matchedHouseLine: trimmed };
  }
  if (/^House rule\b/i.test(trimmed)) {
    for (const houseLine of houseLines) {
      if (trimmed.includes(houseLine) || houseLine.includes(trimmed.replace(/^House rule[:\s]*/i, '').trim())) {
        return { isShadow: true, matchedHouseLine: houseLine };
      }
    }
    return { isShadow: true, matchedHouseLine: undefined };
  }
  return { isShadow: false };
}

/**
 * Detect DENY_ALLOW: same bucket allow at one layer, deny at another.
 * Looks for lines containing "allow" or "deny" that reference similar buckets.
 */
export function detectDenyAllow(
  line: string,
  otherLayerLines: string[],
): { isDenyAllow: boolean; detail: string } {
  const lower = line.toLowerCase().trim();
  const hasDeny = /\bdeny\b/.test(lower);
  const hasAllow = /\ballow\b/.test(lower);
  if (!hasDeny && !hasAllow) return { isDenyAllow: false, detail: '' };

  for (const other of otherLayerLines) {
    const otherLower = other.toLowerCase().trim();
    const otherHasDeny = /\bdeny\b/.test(otherLower);
    const otherHasAllow = /\ballow\b/.test(otherLower);
    if ((hasDeny && otherHasAllow) || (hasAllow && otherHasDeny)) {
      return {
        isDenyAllow: true,
        detail: `Line "${line.trim()}" conflicts with "${other.trim()}" — deny/allow on same bucket`,
      };
    }
  }
  return { isDenyAllow: false, detail: '' };
}

/**
 * Detect DRIFT: house text changed; leaf still has old wording. We detect this
 * by checking if a leaf line is "close but not exact" to a house line — shares
 * a significant prefix but differs.
 */
export function detectDrift(
  leafLine: string,
  houseLines: string[],
  threshold: number = 0.7,
): { isDrift: boolean; matchedHouseLine?: string } {
  const trimmed = leafLine.trim();
  if (trimmed.length < 10) return { isDrift: false };
  for (const houseLine of houseLines) {
    const hTrimmed = houseLine.trim();
    if (hTrimmed === trimmed) continue; // exact match is SHADOW_HOUSE, not DRIFT
    if (hTrimmed.length < 10) continue;

    const shorter = Math.min(trimmed.length, hTrimmed.length);
    let common = 0;
    for (let i = 0; i < shorter; i++) {
      if (trimmed[i] === hTrimmed[i]) common++;
      else break;
    }
    if (common / shorter >= threshold) {
      return { isDrift: true, matchedHouseLine: hTrimmed };
    }
  }
  return { isDrift: false };
}

/**
 * Check whether a file path is safe to patch (SHADOW_HOUSE removal only).
 * Never patch standing, Focus, always.md, never.md, danger.md, or profile.md.
 */
export function isSafePatchTarget(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (FORBIDDEN_PATCH_BASENAMES.has(basename)) return false;
  if (basename === 'profile.md') return false;
  for (const pattern of FORBIDDEN_PATCH_PATH_PATTERNS) {
    if (pattern.test(filePath)) return false;
  }
  return true;
}

/**
 * Apply SHADOW_HOUSE patch: remove duplicate lines from a leaf file.
 * Uses atomic temp+rename. Returns the number of lines removed.
 * Never patches standing / Focus / always / never files.
 */
export function applyShadowPatch(
  leafFilePath: string,
  linesToRemove: Set<string>,
): number {
  if (!isSafePatchTarget(leafFilePath)) {
    logger.warn('AWARENESS', 'CCS Align refusing shadow patch on forbidden target', {
      path: leafFilePath,
    });
    return 0;
  }

  if (!existsSync(leafFilePath)) return 0;

  const original = readFileSync(leafFilePath, 'utf8');
  const originalLines = original.split('\n');
  let removed = 0;

  const patchedLines: string[] = [];
  for (const line of originalLines) {
    if (linesToRemove.has(line.trim()) && line.trim().length > 0) {
      removed++;
    } else {
      patchedLines.push(line);
    }
  }

  if (removed === 0) return 0;

  const patched = patchedLines.join('\n');
  const tmpPath = `${leafFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, patched, 'utf8');
    renameSync(tmpPath, leafFilePath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
    throw error;
  }
  return removed;
}

/**
 * Format a dated section for the append-only rules report.
 */
export function formatReportSection(
  now: Date,
  conflicts: RulesConflict[],
  misses: string[],
  patchesApplied: number,
): string {
  const date = now.toISOString().slice(0, 19).replace('T', ' ');
  const lines: string[] = [];
  lines.push(`## ${date} — CCS Align Phase 2 rules walk`);
  lines.push('');

  if (misses.length > 0) {
    for (const miss of misses) {
      lines.push(`MISS: ${miss}`);
    }
    lines.push('');
  }

  if (conflicts.length === 0 && misses.length === 0) {
    lines.push('No conflicts detected. All layers walked clean.');
    lines.push('');
    return lines.join('\n');
  }

  if (conflicts.length > 0) {
    lines.push(`| Code | Layer | File | Detail |`);
    lines.push(`|------|-------|------|--------|`);
    for (const c of conflicts) {
      const shortFile = c.file.length > 60 ? `…${c.file.slice(-57)}` : c.file;
      const escapedDetail = c.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${c.code} | ${c.layer} | ${shortFile} | ${escapedDetail} |`);
    }
    lines.push('');
  }

  if (patchesApplied > 0) {
    lines.push(`Patches applied: ${patchesApplied} SHADOW_HOUSE lines removed from leaf files.`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write (append) a report section to the rules-report.md file.
 * Uses atomic temp+rename for the full file (append-only sections).
 */
export function appendRulesReport(reportPath: string, section: string): void {
  const dir = path.dirname(reportPath);
  mkdirSync(dir, { recursive: true });

  let existing = '';
  if (existsSync(reportPath)) {
    existing = readFileSync(reportPath, 'utf8');
  }

  if (existing.length === 0) {
    existing = '# CCS Align — Rules Report\n\nAppend-only. Status rolls up to Prioritizer.\n\n';
  }

  const next = existing.endsWith('\n')
    ? `${existing}${section}\n`
    : `${existing}\n${section}\n`;

  const tmpPath = `${reportPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, next, 'utf8');
    renameSync(tmpPath, reportPath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup */ }
    throw error;
  }
}

/**
 * Gather all files from layer paths, reading lines from each found file and
 * recording misses for absent paths.
 */
export function gatherLayerEntries(
  layerPaths: string[],
  layer: 'house' | 'project' | 'seat',
): { entries: LayerEntry[]; misses: string[] } {
  const entries: LayerEntry[] = [];
  const misses: string[] = [];

  for (const p of layerPaths) {
    if (!existsSync(p)) {
      misses.push(`${layer} — ${p}`);
      continue;
    }

    try {
      const stat = statSync(p);
      if (stat.isDirectory()) {
        const files = collectFiles(p);
        if (files.length === 0) {
          misses.push(`${layer} — ${p} (empty directory)`);
        }
        for (const file of files) {
          entries.push({
            layer,
            file,
            lines: readFileLines(file),
            found: true,
          });
        }
      } else {
        entries.push({
          layer,
          file: p,
          lines: readFileLines(p),
          found: true,
        });
      }
    } catch {
      misses.push(`${layer} — ${p} (unreadable)`);
    }
  }

  return { entries, misses };
}

/**
 * Main rules walk: house → project → seat. Detects conflicts, writes report,
 * optionally applies SHADOW_HOUSE patches.
 *
 * On a box with no agent-data tree: report says "MISS: house-box paths" and
 * exits cleanly (returns with zero conflicts, non-zero misses).
 */
export function walkRules(config: RulesWalkerConfig, now: Date = new Date()): RulesWalkResult {
  const reportFile = rulesReportPath(config.dataRoot, config.viewerId);
  const conflicts: RulesConflict[] = [];
  const allMisses: string[] = [];
  let patchesApplied = 0;

  // Gather layers
  const house = gatherLayerEntries(config.housePaths, 'house');
  const project = gatherLayerEntries(config.projectPaths, 'project');
  const seat = gatherLayerEntries(config.seatPaths, 'seat');

  allMisses.push(...house.misses, ...project.misses, ...seat.misses);

  // If every layer path is missing, record a top-level miss
  if (house.entries.length === 0 && project.entries.length === 0 && seat.entries.length === 0) {
    if (config.housePaths.length > 0 || config.projectPaths.length > 0 || config.seatPaths.length > 0) {
      allMisses.push('house-box paths');
    }
  }

  // Build the consolidated house line set for shadow/drift detection
  const houseLineSet = new Set<string>();
  const allHouseLines: string[] = [];
  for (const entry of house.entries) {
    for (const line of entry.lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        houseLineSet.add(trimmed);
        allHouseLines.push(trimmed);
      }
    }
  }

  // Build all house+project lines for deny/allow cross-layer comparison
  const houseProjectLines: string[] = [...allHouseLines];
  for (const entry of project.entries) {
    for (const line of entry.lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) houseProjectLines.push(trimmed);
    }
  }

  const allLayers = [...house.entries, ...project.entries, ...seat.entries];

  // Walk all entries, detecting conflicts
  for (const entry of allLayers) {
    for (const line of entry.lines) {
      // CLOCK_HEADER: any layer
      if (detectClockHeader(line)) {
        conflicts.push({
          code: 'CLOCK_HEADER',
          layer: entry.layer,
          file: entry.file,
          line,
          detail: 'Top-of-prompt clock or "current time is" in a profile (house rule: no clock in prefix)',
        });
      }
    }
  }

  // Seat-layer specific conflict detection (against house)
  const shadowPatchesByFile = new Map<string, Set<string>>();

  for (const entry of seat.entries) {
    for (const line of entry.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      // SHADOW_HOUSE: leaf line also at house (or starts with "House rule")
      const shadow = detectShadowHouse(trimmed, houseLineSet);
      if (shadow.isShadow) {
        conflicts.push({
          code: 'SHADOW_HOUSE',
          layer: 'seat',
          file: entry.file,
          line: trimmed,
          detail: shadow.matchedHouseLine
            ? `Leaf duplicates house line: "${shadow.matchedHouseLine}"`
            : 'Leaf starts with "House rule" — shadows the cascade',
          houseMatch: shadow.matchedHouseLine,
        });

        if (!shadowPatchesByFile.has(entry.file)) {
          shadowPatchesByFile.set(entry.file, new Set());
        }
        shadowPatchesByFile.get(entry.file)!.add(trimmed);
      }

      // DRIFT: leaf line is close-but-not-exact to a house line
      if (!shadow.isShadow) {
        const drift = detectDrift(trimmed, allHouseLines);
        if (drift.isDrift) {
          conflicts.push({
            code: 'DRIFT',
            layer: 'seat',
            file: entry.file,
            line: trimmed,
            detail: drift.matchedHouseLine
              ? `House text may have changed; leaf still has old wording. House: "${drift.matchedHouseLine}"`
              : 'Possible drift from house text',
          });
        }
      }

      // DENY_ALLOW: check seat line against house+project lines
      const denyAllow = detectDenyAllow(trimmed, houseProjectLines);
      if (denyAllow.isDenyAllow) {
        conflicts.push({
          code: 'DENY_ALLOW',
          layer: 'seat',
          file: entry.file,
          line: trimmed,
          detail: denyAllow.detail,
        });
      }
    }
  }

  // Project-layer deny/allow (against house)
  for (const entry of project.entries) {
    for (const line of entry.lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      const denyAllow = detectDenyAllow(trimmed, allHouseLines);
      if (denyAllow.isDenyAllow) {
        conflicts.push({
          code: 'DENY_ALLOW',
          layer: 'project',
          file: entry.file,
          line: trimmed,
          detail: denyAllow.detail,
        });
      }
    }
  }

  // Write the would-be diff into the report BEFORE applying any patches
  const section = formatReportSection(now, conflicts, allMisses, 0);

  // Apply SHADOW_HOUSE patches only if gated on
  if (config.patchShadows && shadowPatchesByFile.size > 0) {
    for (const [filePath, linesToRemove] of shadowPatchesByFile) {
      try {
        const removed = applyShadowPatch(filePath, linesToRemove);
        patchesApplied += removed;
      } catch (error) {
        logger.warn('AWARENESS', 'CCS Align shadow patch failed', {
          file: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // If patches were applied, re-format the section with the count
    if (patchesApplied > 0) {
      const patchedSection = formatReportSection(now, conflicts, allMisses, patchesApplied);
      try {
        appendRulesReport(reportFile, patchedSection);
      } catch (error) {
        logger.warn('AWARENESS', 'CCS Align rules report write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return { conflicts, layers: allLayers, misses: allMisses, reportPath: reportFile, patchesApplied };
    }
  }

  // Write report (no patches or patches disabled)
  try {
    appendRulesReport(reportFile, section);
  } catch (error) {
    logger.warn('AWARENESS', 'CCS Align rules report write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { conflicts, layers: allLayers, misses: allMisses, reportPath: reportFile, patchesApplied };
}

/**
 * Discover house-box paths that may exist on the current machine.
 * Returns paths that should be checked — caller passes them as housePaths,
 * projectPaths, seatPaths.
 */
export function discoverLayerPaths(opts: {
  dataRoot?: string;
  project?: string;
  agentIds?: string[];
} = {}): {
  housePaths: string[];
  projectPaths: string[];
  seatPaths: string[];
} {
  const home = homedir();
  const dataRoot = opts.dataRoot || path.join(home, '.claude-mem');

  const housePaths: string[] = [];
  const projectPaths: string[] = [];
  const seatPaths: string[] = [];

  // House: user-memory/ shared profile
  const userMemory = path.join(home, 'user-memory');
  housePaths.push(userMemory);

  // House: also check home-based agent data
  const agentDataRoot = path.join(home, 'agent-data');
  if (existsSync(agentDataRoot)) {
    housePaths.push(agentDataRoot);
  }

  // Project: .cmem-projects/<project>/
  if (opts.project) {
    const cmemProjects = path.join(dataRoot, '.cmem-projects', opts.project);
    projectPaths.push(cmemProjects);
  }

  // Project: repo CLAUDE.md (workspace root)
  const workspaceClaude = path.join(process.cwd(), 'CLAUDE.md');
  projectPaths.push(workspaceClaude);

  // Seat: agents/<uuid>/profile.md, agents/<uuid>/memory/
  const agentsDir = path.join(agentDataRoot);
  if (opts.agentIds && opts.agentIds.length > 0 && existsSync(agentsDir)) {
    for (const agentId of opts.agentIds) {
      const agentProfile = path.join(agentsDir, 'agents', agentId, 'profile.md');
      const agentMemory = path.join(agentsDir, 'agents', agentId, 'memory');
      seatPaths.push(agentProfile);
      seatPaths.push(agentMemory);
    }
  } else {
    // Discover agent dirs if they exist
    const agentsRoot = path.join(agentDataRoot, 'agents');
    if (existsSync(agentsRoot)) {
      try {
        const entries = readdirSync(agentsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const agentProfile = path.join(agentsRoot, entry.name, 'profile.md');
            const agentMemory = path.join(agentsRoot, entry.name, 'memory');
            seatPaths.push(agentProfile);
            seatPaths.push(agentMemory);
          }
        }
      } catch { /* unreadable agents dir */ }
    }
  }

  return { housePaths, projectPaths, seatPaths };
}
