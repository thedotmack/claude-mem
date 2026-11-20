/**
 * `BUN_BE_BUN=1` turns a `bun build --compile` binary into the bun CLI only
 * from Bun 1.2.16 on. An older embedded runtime ignores it and runs the
 * embedded entrypoint again, so a launcher that re-execs itself with it
 * starts itself forever (#4933). Shared by the launcher (which may only take
 * that fallback on a new enough runtime) and the installer (which refuses to
 * compile the launcher with an older Bun).
 */
export const MINIMUM_BUN_VERSION_FOR_BUN_BE_BUN = '1.2.16';

function parseMajorMinorPatch(version: string): [number, number, number] | null {
  const versionMatch = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!versionMatch) return null;
  return [Number(versionMatch[1]), Number(versionMatch[2]), Number(versionMatch[3])];
}

/** False for an unparseable version: the self-exec fallback must never be guessed at. */
export function bunVersionHonoursBunBeBun(bunVersion: string | undefined): boolean {
  const parsedVersion = parseMajorMinorPatch(bunVersion ?? '');
  const minimumVersion = parseMajorMinorPatch(MINIMUM_BUN_VERSION_FOR_BUN_BE_BUN)!;
  if (!parsedVersion) return false;
  for (let index = 0; index < 3; index++) {
    if (parsedVersion[index] !== minimumVersion[index]) return parsedVersion[index] > minimumVersion[index];
  }
  return true;
}

/**
 * macOS 27 SIGKILLs a launcher whose code signature it rejects. Bun below
 * 1.4.1 produces a binary that signature check rejects, so rebuilding the same
 * way is killed again and the session keeps paying for a failed compile
 * (#5247, suggestion 2). The installer names `bun upgrade` instead of another
 * reinstall, which cannot help.
 */
export const MINIMUM_BUN_VERSION_FOR_SIGNED_LAUNCHER_ON_DARWIN = '1.4.1';

/** False for an unparseable version: never guess that a rebuild would be accepted. */
export function bunVersionHonoursMacosSignatureFix(bunVersion: string | undefined): boolean {
  const parsedVersion = parseMajorMinorPatch(bunVersion ?? '');
  const minimumVersion = parseMajorMinorPatch(MINIMUM_BUN_VERSION_FOR_SIGNED_LAUNCHER_ON_DARWIN)!;
  if (!parsedVersion) return false;
  for (let index = 0; index < 3; index++) {
    if (parsedVersion[index] !== minimumVersion[index]) return parsedVersion[index] > minimumVersion[index];
  }
  return true;
}
