#!/usr/bin/env node
// Sign a long-lived bearer token for sqld's JWT auth, for local dev only.
//
// Usage (uses bunx so we don't pollute the repo's package.json):
//   bunx --bun jose@5 ...     <-- jose ships its own CLI we DON'T use; we
//                                  invoke jose's Node API instead.
//
//   bun ./sign-jwt.mjs --key ./sqld-private.pem [--exp 365d] [--sub claude-mem-dev]
//
// Equivalent with Node 20+ (npx fetches `jose` per-invocation, no install):
//   npx -y -p jose@5 node ./sign-jwt.mjs --key ./sqld-private.pem
//
// Output: a single-line JWT to stdout. Pass it to clients as the bearer
// token (e.g. `--target-token "$TURSO_AUTH_TOKEN"` to the Phase 1 bootstrap
// script, or as the `authToken` field in `createClient({...})`).
//
// Spec: sqld accepts JWTs signed with the Ed25519 private key whose matching
// public key is configured via SQLD_AUTH_JWT_KEY. See:
//   https://github.com/tursodatabase/libsql/blob/main/libsql-server/README.md
//   https://docs.turso.tech/features/embedded-replicas/introduction

import { readFileSync } from 'node:fs';
import { argv, exit, stdout, stderr } from 'node:process';
import { SignJWT, importPKCS8 } from 'jose';

function parseArgs(rawArgs) {
  const out = { key: null, exp: '365d', sub: 'claude-mem-dev' };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const flag = rawArgs[i];
    if (flag === '--key') {
      out.key = rawArgs[i + 1];
      i += 1;
    } else if (flag === '--exp') {
      out.exp = rawArgs[i + 1];
      i += 1;
    } else if (flag === '--sub') {
      out.sub = rawArgs[i + 1];
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      stdout.write(
        'Usage: bun sign-jwt.mjs --key <private.pem> [--exp 365d] [--sub claude-mem-dev]\n',
      );
      exit(0);
    }
  }
  return out;
}

const args = parseArgs(argv.slice(2));
if (!args.key) {
  stderr.write('error: --key <path-to-Ed25519-private-pem> is required\n');
  exit(2);
}

const pem = readFileSync(args.key, 'utf8');
const privateKey = await importPKCS8(pem, 'EdDSA');

const token = await new SignJWT({})
  .setProtectedHeader({ alg: 'EdDSA' })
  .setSubject(args.sub)
  .setIssuedAt()
  .setExpirationTime(args.exp)
  .sign(privateKey);

stdout.write(`${token}\n`);
