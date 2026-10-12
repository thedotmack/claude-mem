#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function fail(message) {
  console.error(`mode-creator Telegram setup: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith('--') || !value) fail('usage: configure-telegram.mjs [--types <csv>] [--concepts <csv>]');
    result[token.slice(2)] = value;
  }
  return result;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value?.startsWith('~/') || value?.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  const defaultDir = path.join(homedir(), '.claude-mem');
  const defaultSettings = path.join(defaultDir, 'settings.json');
  if (!existsSync(defaultSettings)) return defaultDir;
  const parsed = readJson(defaultSettings);
  const flat = parsed.env && typeof parsed.env === 'object' ? parsed.env : parsed;
  return flat.CLAUDE_MEM_DATA_DIR ? expandHome(flat.CLAUDE_MEM_DATA_DIR) : defaultDir;
}

function splitCsv(value) {
  return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function mergeCsv(existing, additions) {
  return [...new Set([...splitCsv(existing), ...additions])].join(',');
}

async function promptLine(label, { hidden = false, allowEmpty = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('interactive terminal required; run this helper directly in your terminal');
  }
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let value = '';
  return await new Promise((resolve, reject) => {
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          if (!allowEmpty && value.trim().length === 0) continue;
          finish();
          resolve(value.trim());
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += character;
        process.stdout.write(hidden ? '•' : character);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function askYesNo(label, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await promptLine(`${label}${suffix}`, { allowEmpty: true })).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

async function telegramCall(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const description = payload?.description ?? `${response.status} ${response.statusText}`;
    throw new Error(`${method} failed: ${description}`);
  }
  return payload.result;
}

function chatsFromUpdates(updates) {
  const chats = new Map();
  for (const update of updates) {
    const chat = update.message?.chat
      ?? update.edited_message?.chat
      ?? update.channel_post?.chat
      ?? update.callback_query?.message?.chat;
    if (!chat) continue;
    const label = chat.title ?? chat.username ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ') ?? String(chat.id);
    chats.set(String(chat.id), label || String(chat.id));
  }
  return [...chats.entries()];
}

function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, filePath);
}

const args = parseArgs(process.argv.slice(2));
const types = splitCsv(args.types);
const concepts = splitCsv(args.concepts);
const dataDir = resolveDataDir();
const settingsPath = path.join(dataDir, 'settings.json');
let settings = existsSync(settingsPath) ? readJson(settingsPath) : {};
if (settings.env && typeof settings.env === 'object') settings = settings.env;

try {
  let token = process.env.CLAUDE_MEM_TELEGRAM_BOT_TOKEN ?? '';
  if (!token && settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN) {
    if (await askYesNo('Use the Telegram bot token already saved in claude-mem?')) {
      token = settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN;
    }
  }
  if (!token) token = await promptLine('Paste the BotFather token (input is hidden): ', { hidden: true });

  const bot = await telegramCall(token, 'getMe');
  console.log(`Authenticated as @${bot.username ?? bot.first_name}.`);

  let chatId = process.env.CLAUDE_MEM_TELEGRAM_CHAT_ID ?? '';
  if (!chatId && settings.CLAUDE_MEM_TELEGRAM_CHAT_ID) {
    if (await askYesNo(`Use the saved chat ID ${settings.CLAUDE_MEM_TELEGRAM_CHAT_ID}?`)) {
      chatId = settings.CLAUDE_MEM_TELEGRAM_CHAT_ID;
    }
  }

  if (!chatId) {
    console.log(`Open https://t.me/${bot.username}, press Start, and send any message.`);
    await promptLine('Press Enter after the message has been sent: ', { allowEmpty: true });
    try {
      const chats = chatsFromUpdates(await telegramCall(token, 'getUpdates'));
      if (chats.length === 1 && await askYesNo(`Use ${chats[0][1]} (${chats[0][0]})?`)) {
        chatId = chats[0][0];
      } else if (chats.length > 1) {
        console.log('Recent chats:');
        for (const [id, label] of chats) console.log(`  ${id}  ${label}`);
      }
    } catch (error) {
      console.warn(`Could not discover the chat automatically (${error instanceof Error ? error.message : String(error)}).`);
      console.warn('This commonly happens when the bot already has a webhook; enter the chat ID manually.');
    }
  }
  if (!chatId) chatId = await promptLine('Telegram chat ID (numeric, groups are usually negative): ');
  if (!/^-?\d+$/.test(chatId) && !/^@[A-Za-z0-9_]{5,}$/.test(chatId)) fail('chat ID must be numeric or an @channel username');

  await telegramCall(token, 'sendMessage', {
    chat_id: chatId,
    text: '✅ claude-mem Telegram notifications are connected.',
  });

  const backupPath = existsSync(settingsPath)
    ? `${settingsPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;
  if (backupPath) {
    copyFileSync(settingsPath, backupPath);
    chmodSync(backupPath, 0o600);
  }
  settings.CLAUDE_MEM_TELEGRAM_ENABLED = 'true';
  settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN = token;
  settings.CLAUDE_MEM_TELEGRAM_CHAT_ID = chatId;
  if (types.length > 0) settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES = mergeCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES, types);
  if (concepts.length > 0) settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS = mergeCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS, concepts);
  atomicWriteJson(settingsPath, settings);

  console.log(JSON.stringify({
    ok: true,
    bot: bot.username ?? bot.first_name,
    chatId,
    triggerTypes: splitCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES),
    triggerConcepts: splitCsv(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS),
    settingsPath,
    backupPath,
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
