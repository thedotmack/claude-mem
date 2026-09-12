/**
 * Foreign-Python isolation for uvx-spawned children (#3552).
 *
 * `uvx --python 3.13` builds its own ephemeral environment, but CPython still
 * honours the ambient interpreter variables it inherits. When claude-mem's
 * worker is started from an activated venv or a conda shell, the chroma-mcp
 * child inherits that foreign prefix and imports the OUTER interpreter's
 * site-packages on top of uv's. The usual result is a numpy ABI clash
 * (`numpy.dtype size changed`) raised during chromadb import — which surfaces
 * as semantic sync stopping *silently*, because the failure happens in the
 * subprocess before the MCP handshake completes.
 *
 * Stripping these five is the whole fix: uv then resolves the interpreter and
 * its search path itself, which is what `--python` already promised.
 *
 * Kept as one exported rule rather than duplicated inline so the uvx env
 * builders cannot drift apart (they already had two parallel PATH
 * implementations).
 */

/**
 * Ambient interpreter/prefix variables that must never reach a uvx child.
 *
 * - VIRTUAL_ENV / CONDA_PREFIX / CONDA_DEFAULT_ENV: mark an activated outer
 *   environment; uv and CPython both consult them to locate a prefix.
 * - PYTHONHOME: overrides the standard-library location outright.
 * - PYTHONPATH: prepends foreign site-packages to sys.path — the direct
 *   numpy/ABI vector.
 */
export const FOREIGN_PYTHON_ENV_VARS = [
  'VIRTUAL_ENV',
  'PYTHONHOME',
  'PYTHONPATH',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
] as const;

/**
 * Remove every foreign-Python variable from an env map, in place.
 *
 * Case sensitivity follows the platform, and on Windows that is load-bearing:
 * Windows environment names are case-INSENSITIVE, so a shell that exported
 * `PythonPath=C:\foreign\Lib\site-packages` or `Virtual_Env=...` produces a
 * variable CPython honours in full while an exact-uppercase delete misses it
 * entirely — #3552 fires anyway. Every case variant is therefore removed on
 * win32, which also guarantees no duplicate case-variant key survives into the
 * child (`PYTHONPATH` and `PythonPath` are the same variable to the OS, and
 * handing both to a child is undefined behavior).
 *
 * `platform` is injectable so the Windows rule is testable off-Windows.
 *
 * Mutates rather than copies to match the sibling `ensureUvOnPath()` idiom in
 * ChromaMcpManager: both are applied to a freshly built env object that the
 * caller owns.
 */
export function stripForeignPythonEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32') {
    for (const key of FOREIGN_PYTHON_ENV_VARS) {
      delete env[key];
    }
    return;
  }

  const targets = new Set<string>(FOREIGN_PYTHON_ENV_VARS.map(key => key.toLowerCase()));
  for (const key of Object.keys(env)) {
    if (targets.has(key.toLowerCase())) {
      delete env[key];
    }
  }
}
