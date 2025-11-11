#!/usr/bin/env node

/**
 * Generate CHANGELOG.md from GitHub releases
 *
 * Fetches all releases from GitHub and formats them into Keep a Changelog format.
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

function exec(command) {
  try {
    return execSync(command, { encoding: 'utf-8' });
  } catch (error) {
    console.error(`Error executing command: ${command}`);
    console.error(error.message);
    process.exit(1);
  }
}

function getReleases() {
  console.log('📋 Fetching releases from GitHub...');
  const releasesJson = exec('gh release list --limit 1000 --json tagName,publishedAt,name');
  const releases = JSON.parse(releasesJson);

  // Fetch body for each release
  console.log(`📥 Fetching details for ${releases.length} releases...`);
  for (const release of releases) {
    const body = exec(`gh release view ${release.tagName} --json body --jq '.body'`).trim();
    release.body = body;
  }

  return releases;
}

function formatDate(isoDate) {
  const date = new Date(isoDate);
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function cleanReleaseBody(body) {
  // Remove the "Generated with Claude Code" footer
  return body
    .replace(/🤖 Generated with \[Claude Code\].*$/s, '')
    .replace(/---\n*$/s, '')
    .trim();
}

function extractVersion(tagName) {
  // Remove 'v' prefix from tag name
  return tagName.replace(/^v/, '');
}

function generateChangelog(releases) {
  console.log(`📝 Generating CHANGELOG.md from ${releases.length} releases...`);

  const lines = [
    '# Changelog',
    '',
    'All notable changes to this project will be documented in this file.',
    '',
    'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).',
    '',
  ];

  // Sort releases by date (newest first)
  releases.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  for (const release of releases) {
    const version = extractVersion(release.tagName);
    const date = formatDate(release.publishedAt);
    const body = cleanReleaseBody(release.body);

    // Add version header
    lines.push(`## [${version}] - ${date}`);
    lines.push('');

    // Add release body
    if (body) {
      // Remove the initial markdown heading if it exists (e.g., "## v5.5.0 (2025-11-11)")
      const bodyWithoutHeader = body.replace(/^##?\s+v?[\d.]+.*?\n\n?/m, '');
      lines.push(bodyWithoutHeader);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function main() {
  console.log('🔧 Generating CHANGELOG.md from GitHub releases...\n');

  const releases = getReleases();

  if (releases.length === 0) {
    console.log('⚠️  No releases found');
    return;
  }

  const changelog = generateChangelog(releases);

  writeFileSync('CHANGELOG.md', changelog, 'utf-8');

  console.log('\n✅ CHANGELOG.md generated successfully!');
  console.log(`   ${releases.length} releases processed`);
}

main();
