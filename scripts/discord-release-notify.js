#!/usr/bin/env node

/**
 * Post release notification to Discord
 *
 * Usage:
 *   node scripts/discord-release-notify.js v7.4.2
 *   node scripts/discord-release-notify.js v7.4.2 "Custom release notes"
 *
 * Requires DISCORD_UPDATES_WEBHOOK in .env file
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function loadEnv() {
  const envPath = resolve(projectRoot, '.env');
  if (!existsSync(envPath)) {
    console.error('❌ .env file not found');
    process.exit(1);
  }

  const envContent = readFileSync(envPath, 'utf-8');
  const webhookMatch = envContent.match(/DISCORD_UPDATES_WEBHOOK=(.+)/);

  if (!webhookMatch) {
    console.error('❌ DISCORD_UPDATES_WEBHOOK not found in .env');
    process.exit(1);
  }

  return webhookMatch[1].trim();
}

function getReleaseNotes(version) {
  try {
    const notes = execSync(`gh release view ${version} --json body --jq '.body'`, {
      encoding: 'utf-8',
      cwd: projectRoot,
    }).trim();
    return notes;
  } catch {
    return null;
  }
}

function cleanNotes(notes) {
  // Remove Claude Code footer and clean up
  return notes
    .replace(/🤖 Generated with \[Claude Code\].*$/s, '')
    .replace(/---\n*$/s, '')
    .trim();
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

async function postToDiscord(webhookUrl, version, notes) {
  const cleanedNotes = notes ? cleanNotes(notes) : 'No release notes available.';
  const repoUrl = 'https://github.com/thedotmack/claude-mem';

  const payload = {
    embeds: [
      {
        title: `🚀 claude-mem ${version} released`,
        url: `${repoUrl}/releases/tag/${version}`,
        description: truncate(cleanedNotes, 2000),
        color: 0x7c3aed, // Purple
        fields: [
          {
            name: '📦 Install',
            value: 'Update via Claude Code plugin marketplace',
            inline: true,
          },
          {
            name: '📚 Docs',
            value: '[docs.claude-mem.ai](https://docs.claude-mem.ai)',
            inline: true,
          },
        ],
        footer: {
          text: 'claude-mem • Persistent memory for Claude Code',
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord API error: ${response.status} - ${errorText}`);
  }

  return true;
}

async function main() {
  const version = process.argv[2];
  const customNotes = process.argv[3];

  if (!version) {
    console.error('Usage: node scripts/discord-release-notify.js <version> [notes]');
    console.error('Example: node scripts/discord-release-notify.js v7.4.2');
    process.exit(1);
  }

  console.log(`📣 Posting release notification for ${version}...`);

  const webhookUrl = loadEnv();
  const notes = customNotes || getReleaseNotes(version);

  if (!notes && !customNotes) {
    console.warn('⚠️  Could not fetch release notes from GitHub, proceeding without them');
  }

  try {
    await postToDiscord(webhookUrl, version, notes);
    console.log('✅ Discord notification sent successfully!');
  } catch (error) {
    console.error('❌ Failed to send Discord notification:', error.message);
    process.exit(1);
  }
}

main();
