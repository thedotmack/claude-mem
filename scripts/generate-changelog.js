#!/usr/bin/env node

/**
 * Generate CHANGELOG.md from GitHub releases.
 *
 * Incremental by default: reads existing CHANGELOG.md, only fetches releases
 * newer than the newest version already documented, and prepends them.
 *
 * Pass --full to force a complete regeneration from every release.
 */

import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const CHANGELOG_PATH = 'CHANGELOG.md';
const HEADER_LINES = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).',
  '',
];

function exec(command) {
  try {
    return execSync(command, { encoding: 'utf-8' });
  } catch (error) {
    console.error(`Error executing command: ${command}`);
    console.error(error.message);
    process.exit(1);
  }
}

function listReleases() {
  const releasesJson = exec('gh release list --limit 1000 --json tagName,publishedAt,name');
  return JSON.parse(releasesJson);
}

function fetchReleaseBody(tagName) {
  return exec(`gh release view ${tagName} --json body --jq '.body'`).trim();
}

function formatDate(isoDate) {
  return new Date(isoDate).toISOString().split('T')[0];
}

function cleanReleaseBody(body) {
  return body
    .replace(/🤖 Generated with \[Claude Code\].*$/s, '')
    .replace(/---\n*$/s, '')
    .trim();
}

function extractVersion(tagName) {
  return tagName.replace(/^v/, '');
}

function renderEntry(release) {
  const version = extractVersion(release.tagName);
  const date = formatDate(release.publishedAt);
  const body = cleanReleaseBody(release.body);
  const lines = [`## [${version}] - ${date}`, ''];
  if (body) {
    const bodyWithoutHeader = body.replace(/^##?\s+v?[\d.]+.*?\n\n?/m, '');
    lines.push(bodyWithoutHeader);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Parse the existing CHANGELOG.md and return:
 *   - knownVersions: Set of version strings already present
 *   - body: the content following the standard header (entries only)
 */
function readExistingChangelog() {
  if (!existsSync(CHANGELOG_PATH)) {
    return { knownVersions: new Set(), body: '' };
  }
  const content = readFileSync(CHANGELOG_PATH, 'utf-8');
  const knownVersions = new Set();
  const versionHeaderRe = /^## \[([^\]]+)\]/gm;
  let match;
  while ((match = versionHeaderRe.exec(content)) !== null) {
    knownVersions.add(match[1]);
  }
  // Strip the standard header so we can re-emit it cleanly
  const firstEntryIndex = content.search(/^## \[/m);
  const body = firstEntryIndex === -1 ? '' : content.slice(firstEntryIndex);
  return { knownVersions, body };
}

function main() {
  const fullRegen = process.argv.includes('--full');

  console.log('🔧 Generating CHANGELOG.md from GitHub releases...\n');

  const { knownVersions, body: existingBody } = fullRegen
    ? { knownVersions: new Set(), body: '' }
    : readExistingChangelog();

  console.log('📋 Fetching release list from GitHub...');
  const allReleases = listReleases();

  if (allReleases.length === 0) {
    console.log('⚠️  No releases found');
    return;
  }

  const newReleases = allReleases.filter(
    (release) => !knownVersions.has(extractVersion(release.tagName)),
  );

  if (newReleases.length === 0) {
    console.log('✅ CHANGELOG.md is already up to date.');
    return;
  }

  console.log(
    `📥 Fetching bodies for ${newReleases.length} new release(s)` +
      (fullRegen ? '' : ` (${knownVersions.size} already in CHANGELOG)`) +
      '...',
  );
  for (const release of newReleases) {
    release.body = fetchReleaseBody(release.tagName);
  }

  newReleases.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const newEntriesBlock = newReleases.map(renderEntry).join('\n');

  const finalBody = existingBody
    ? `${newEntriesBlock}\n${existingBody}`.trimEnd() + '\n'
    : `${newEntriesBlock}`.trimEnd() + '\n';

  const changelog = HEADER_LINES.join('\n') + '\n' + finalBody;
  writeFileSync(CHANGELOG_PATH, changelog, 'utf-8');

  console.log('\n✅ CHANGELOG.md generated successfully!');
  console.log(`   ${newReleases.length} new release(s) prepended`);
}

main();
