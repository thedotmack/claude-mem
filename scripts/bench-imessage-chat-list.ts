/** Run with: bun scripts/bench-imessage-chat-list.ts */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatDbSource } from '../src/integrations/imessage-observer/chatdb-source.js';
import { FakeChatDb } from '../tests/fixtures/imessage/fake-chat-db.js';

const dir = mkdtempSync(join(tmpdir(), 'cmem-chat-list-bench-'));
const fake = new FakeChatDb(join(dir, 'chat.db'));
const chatCount = 2_000;
const membersPerChat = 4;
try {
  const addresses = Array.from({ length: 20 }, (_, index) => `person-${index}@example.com`);
  fake.db.exec('BEGIN');
  for (const address of addresses) fake.handle(address);
  for (let index = 0; index < chatCount; index++) {
    const guid = `iMessage;+;group-${index}`;
    fake.chat(guid, {
      group: true,
      name: index % 2 ? `Group ${index}` : undefined,
      members: Array.from({ length: membersPerChat }, (_, member) => addresses[(index + member) % addresses.length]!),
    });
    fake.message({ chat: guid, guid: `message-${index}`, at: 1_700_000_000_000 + index, text: 'hello' });
  }
  fake.db.exec('COMMIT');
  const source = new ChatDbSource({ dbPath: fake.path, label: address => address, isObserved: () => false, watch: false });
  const samples: number[] = [];
  for (let run = 0; run < 30; run++) {
    const started = performance.now();
    const chats = source.listChats();
    const elapsed = performance.now() - started;
    if (chats.length !== chatCount || chats.some(chat => chat.members.length !== membersPerChat || chat.messageCount !== 1)) {
      throw new Error('Chat list results changed');
    }
    if (run >= 4) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({
    runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
    chats: chatCount,
    membersPerChat,
    samples: samples.length,
    medianMs: samples[Math.floor(samples.length / 2)],
    minMs: samples[0],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
  }, null, 2));
} finally {
  fake.close();
  rmSync(dir, { recursive: true, force: true });
}
