#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const ITEM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_PROMPTS = [
  'system_identity',
  'spatial_awareness',
  'observer_role',
  'recording_focus',
  'skip_guidance',
  'type_guidance',
  'concept_guidance',
  'field_guidance',
  'output_format_header',
  'format_examples',
  'footer',
  'xml_title_placeholder',
  'xml_subtitle_placeholder',
  'xml_fact_placeholder',
  'xml_narrative_placeholder',
  'xml_concept_placeholder',
  'xml_file_placeholder',
  'xml_summary_request_placeholder',
  'xml_summary_investigated_placeholder',
  'xml_summary_learned_placeholder',
  'xml_summary_completed_placeholder',
  'xml_summary_next_steps_placeholder',
  'xml_summary_notes_placeholder',
  'header_memory_start',
  'header_memory_continued',
  'header_summary_checkpoint',
  'continuation_greeting',
  'continuation_instruction',
  'summary_instruction',
  'summary_context_label',
  'summary_format_instruction',
  'summary_footer',
];

function fail(message) {
  console.error(`mode-creator: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'dry-run' || key === 'no-activate') {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value?.startsWith('~/') || value?.startsWith('~\\')) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`could not parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  const defaultDir = path.join(homedir(), '.claude-mem');
  const defaultSettings = path.join(defaultDir, 'settings.json');
  if (!existsSync(defaultSettings)) return defaultDir;
  const parsed = readJson(defaultSettings, 'claude-mem settings');
  const flat = parsed.env && typeof parsed.env === 'object' ? parsed.env : parsed;
  return flat.CLAUDE_MEM_DATA_DIR ? expandHome(flat.CLAUDE_MEM_DATA_DIR) : defaultDir;
}

function deepMerge(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
    ) {
      result[key] = deepMerge(baseValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function splitCsv(value) {
  return String(value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function mergeCsv(existing, additions) {
  return [...new Set([...splitCsv(existing), ...additions])].join(',');
}

function requireString(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
}

function validateItems(items, label, requiredFields) {
  if (!Array.isArray(items) || items.length === 0) fail(`${label} must contain at least one item`);
  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label}[${index}] must be an object`);
    for (const field of requiredFields) requireString(item[field], `${label}[${index}].${field}`);
    if (!ITEM_ID_PATTERN.test(item.id)) fail(`${label}[${index}].id must be lowercase kebab-case`);
    if (seen.has(item.id)) fail(`${label} contains duplicate id: ${item.id}`);
    seen.add(item.id);
  }
}

function validateMergedMode(mode) {
  if (!mode || typeof mode !== 'object' || Array.isArray(mode)) fail('mode must be a JSON object');
  requireString(mode.name, 'name');
  requireString(mode.description, 'description');
  requireString(mode.version, 'version');
  validateItems(mode.observation_types, 'observation_types', ['id', 'label', 'description', 'emoji', 'work_emoji']);
  validateItems(mode.observation_concepts, 'observation_concepts', ['id', 'label', 'description']);
  if (!mode.prompts || typeof mode.prompts !== 'object' || Array.isArray(mode.prompts)) {
    fail('prompts must be an object');
  }
  for (const prompt of REQUIRED_PROMPTS) requireString(mode.prompts[prompt], `prompts.${prompt}`, prompt === 'format_examples');
  for (const type of mode.observation_types) {
    if (!mode.prompts.type_guidance.includes(type.id)) fail(`prompts.type_guidance does not mention type: ${type.id}`);
  }
  for (const concept of mode.observation_concepts) {
    if (!mode.prompts.concept_guidance.includes(concept.id)) fail(`prompts.concept_guidance does not mention concept: ${concept.id}`);
  }
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, filePath);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const args = parseArgs(process.argv.slice(2));
if (!args.mode) fail('usage: install-mode.mjs --mode <draft.json> [--mode-id <id>] [--telegram-types <csv>] [--telegram-concepts <csv>] [--dry-run]');

const sourcePath = path.resolve(args.mode);
if (!existsSync(sourcePath)) fail(`draft mode file not found: ${sourcePath}`);
const modeId = args['mode-id'] ?? path.basename(sourcePath, path.extname(sourcePath));
if (!MODE_ID_PATTERN.test(modeId)) fail('mode ID must be lowercase kebab-case, optionally parent--override');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundledModesDir = path.resolve(scriptDir, '../../../modes');
const dataDir = resolveDataDir();
const userModesDir = path.join(dataDir, 'modes');
const settingsPath = path.join(dataDir, 'settings.json');
const destinationPath = path.join(userModesDir, `${modeId}.json`);
const draft = readJson(sourcePath, 'draft mode');

if (existsSync(path.join(bundledModesDir, `${modeId}.json`))) {
  fail(`mode ID collides with bundled mode: ${modeId}; choose a unique custom ID instead of shadowing bundled configuration`);
}

let merged = draft;
const inheritanceParts = modeId.split('--');
if (inheritanceParts.length === 2) {
  const parentId = inheritanceParts[0];
  const parentCandidates = [
    path.join(userModesDir, `${parentId}.json`),
    path.join(bundledModesDir, `${parentId}.json`),
  ];
  const parentPath = parentCandidates.find(candidate => existsSync(candidate));
  if (!parentPath) fail(`parent mode not found: ${parentId}`);
  merged = deepMerge(readJson(parentPath, `parent mode ${parentId}`), draft);
} else if (inheritanceParts.length !== 1) {
  fail('only one inheritance level is supported');
}

validateMergedMode(merged);

const typeIds = new Set(merged.observation_types.map(item => item.id));
const conceptIds = new Set(merged.observation_concepts.map(item => item.id));
const telegramTypes = splitCsv(args['telegram-types']);
const telegramConcepts = splitCsv(args['telegram-concepts']);
for (const type of telegramTypes) if (!typeIds.has(type)) fail(`Telegram trigger type is not in this mode: ${type}`);
for (const concept of telegramConcepts) if (!conceptIds.has(concept)) fail(`Telegram trigger concept is not in this mode: ${concept}`);

if (args['dry-run']) {
  console.log(JSON.stringify({ ok: true, dryRun: true, modeId, sourcePath, destinationPath, telegramTypes, telegramConcepts }, null, 2));
  process.exit(0);
}

mkdirSync(userModesDir, { recursive: true, mode: 0o700 });
const backupStamp = timestamp();
let modeBackup = null;
if (existsSync(destinationPath)) {
  modeBackup = `${destinationPath}.backup-${backupStamp}`;
  copyFileSync(destinationPath, modeBackup);
  chmodSync(modeBackup, 0o600);
}
atomicWriteJson(destinationPath, draft);

let settings = {};
let settingsBackup = null;
if (existsSync(settingsPath)) {
  const parsed = readJson(settingsPath, 'claude-mem settings');
  settings = parsed.env && typeof parsed.env === 'object' ? parsed.env : parsed;
  settingsBackup = `${settingsPath}.backup-${backupStamp}`;
  copyFileSync(settingsPath, settingsBackup);
  chmodSync(settingsBackup, 0o600);
}
if (!args['no-activate']) settings.CLAUDE_MEM_MODE = modeId;
if (telegramTypes.length > 0 || telegramConcepts.length > 0) {
  settings.CLAUDE_MEM_TELEGRAM_ENABLED = 'true';
  settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES = mergeCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES, telegramTypes);
  settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS = mergeCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS, telegramConcepts);
}
atomicWriteJson(settingsPath, settings);

console.log(JSON.stringify({
  ok: true,
  modeId,
  modeName: merged.name,
  installedAt: destinationPath,
  activated: !args['no-activate'],
  telegramTypes,
  telegramConcepts,
  backups: { mode: modeBackup, settings: settingsBackup },
}, null, 2));
