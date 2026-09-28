# Self-hosted, end-to-end encrypted Sync Hub

Run the Sync Hub for one person in your own Cloudflare account (Workers Free
plan) and share claude-mem memories across your devices without the hub, or
Cloudflare, ever seeing their content.

This exists so memories can follow you into Claude Code cloud sessions under
a key only you hold. It is not meant to replace or compete with cmem.ai Pro,
which remains the managed way to sync; the self-hosted hub is run, paid for
and supported by whoever deploys it.

## What changes compared to the cmem.ai hub

| | cmem.ai Pro (`wrangler.jsonc`) | Self-host (`wrangler.self-host.jsonc`) |
|---|---|---|
| Auth | cmem.ai token verifier + KV cache | One bearer secret `SELF_HOST_TOKEN`, pinned to `SELF_HOST_USER_ID` |
| Payloads | Plaintext, validated field by field | `OPAQUE_PAYLOADS=1`: must be sealed (`cmem-e2e-v1`), plaintext refused |
| Push ack | After the cmem.ai search projector catches up | `PROJECTION_MODE=none`: once durable in the log |
| Control plane | `/internal/*`, watchdog, kill switch in KV | None (404, no KV, no crons) |
| Entry module | `src/index.ts` | `src/self-host-entry.ts` (only the handler and the Durable Object) |

The envelope stays in the clear and fully validated: stable ids, kinds,
revisions, device ids, deletion markers and hashes. Ordering, idempotent
retries and revision conflicts work exactly as on the cmem.ai hub.

## Encryption (client side)

`src/services/sync/E2ECodec.ts`, enabled by `CLAUDE_MEM_CLOUD_SYNC_E2E=true`.

- 32-byte key in `<data dir>/sync-e2e.key` (mode 0600). HKDF-SHA256 derives an
  AES-256-GCM key and an HMAC key.
- Sealing is deterministic: nonce = HMAC(aad, plaintext). The protocol needs
  it: the hub rejects different bytes at an already-acked revision, and the
  client rebuilds acked ops to compare hashes before stamping them.
- Associated data binds each ciphertext to its envelope (id, kind, revision,
  origin device), so a sealed payload can't be replayed under another entity or
  revision.
- A device with a different key applies nothing: the pull fails before any
  row is written, and sync keeps retrying.

## Setup

See "Self-hosted, end-to-end encrypted hub" in `docs/public/cloud-sync.mdx`.
`npm run self-host:setup` deploys, sets both secrets through stdin, waits for
the hub to accept them and writes `~/.cloudflare/cmem-sync.env` (0600). Keep
that file and the exported key; both are needed on every device.

## Tests

```bash
npm run test:self-host   # vitest.self-host.config.ts: auth, opaque payloads, no outbound calls
npm test                 # the cmem.ai Pro suite, unchanged
```
