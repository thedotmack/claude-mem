// SPDX-License-Identifier: Apache-2.0
//
// BUG 33 fix — runtime-adaptive argon2id shim.
//
// The npm `argon2` package compiles a native node-gyp addon. In the Docker
// server-beta image we install with `--ignore-scripts` (BUG 32) to skip the
// fragile tree-sitter native compile, which also leaves argon2 without a
// native build. At runtime, importing argon2 then throws:
//
//   error: No native build was found for platform=linux arch=arm64
//   runtime=node abi=137 ...
//
// Bun (which is what server-beta-service.cjs runs under) ships argon2id in
// `Bun.password.hash()` and `Bun.password.verify()` — first-class APIs with
// PHC-string output ($argon2id$v=19$m=...$...$...) fully interoperable with
// the npm package's format.
//
// This shim picks Bun.password when available, otherwise lazily requires
// the npm package. The native dep is no longer mandatory.
//
// Output format is identical either way ($argon2id PHC strings), so the
// dual-verifier in postgres-auth.ts continues to detect existing hashes
// without migration.

export interface Argon2HashOptions {
  memoryCost?: number;
  timeCost?: number;
  parallelism?: number;
}

const DEFAULT_OPTS: Required<Argon2HashOptions> = {
  memoryCost: 19456, // 19 MiB — OWASP 2024 minimum
  timeCost: 2,
  parallelism: 1,
};

// Runtime detection — Bun ships argon2id natively.
// `Bun` global is only defined under the Bun runtime.
const isBun = typeof (globalThis as any).Bun !== 'undefined' && typeof (globalThis as any).Bun?.password?.hash === 'function';

interface NativeArgon2 {
  hash: (rawKey: string, opts: { type: number; memoryCost: number; timeCost: number; parallelism: number }) => Promise<string>;
  verify: (storedHash: string, rawKey: string) => Promise<boolean>;
  argon2id: number;
}

let nativeArgon2: NativeArgon2 | null = null;
function loadNativeArgon2(): NativeArgon2 {
  if (nativeArgon2) return nativeArgon2;
  // Lazy require so Bun-only deployments never touch the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  nativeArgon2 = require('argon2') as NativeArgon2;
  return nativeArgon2;
}

export async function hashApiKeyForStorage(rawKey: string, opts: Argon2HashOptions = DEFAULT_OPTS): Promise<string> {
  const merged = { ...DEFAULT_OPTS, ...opts };
  if (isBun) {
    return (globalThis as any).Bun.password.hash(rawKey, {
      algorithm: 'argon2id',
      memoryCost: merged.memoryCost,
      timeCost: merged.timeCost,
      parallelism: merged.parallelism,
    });
  }
  const a2 = loadNativeArgon2();
  return a2.hash(rawKey, {
    type: a2.argon2id,
    memoryCost: merged.memoryCost,
    timeCost: merged.timeCost,
    parallelism: merged.parallelism,
  });
}

export async function verifyArgon2(storedHash: string, rawKey: string): Promise<boolean> {
  if (isBun) {
    try {
      return await (globalThis as any).Bun.password.verify(rawKey, storedHash);
    } catch {
      // Malformed PHC string — treat as no-match. Never throw, so timing
      // analysis can't enumerate format details via error shape.
      return false;
    }
  }
  const a2 = loadNativeArgon2();
  try {
    return await a2.verify(storedHash, rawKey);
  } catch {
    return false;
  }
}
