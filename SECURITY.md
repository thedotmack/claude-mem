# Security Policy

## Supported Versions

Only the latest released version of `claude-mem` receives security updates. Please upgrade to the latest version before reporting a vulnerability.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in claude-mem, please report it by:

1. **DO NOT** create a public GitHub issue, pull request, or discussion
2. Email **alex@cmem.ai** with details, OR use GitHub's "Report a vulnerability" button under the Security tab to open a private security advisory
3. Include steps to reproduce, impact assessment, affected version(s), and suggested fixes if possible

**Scope:** This policy covers the `claude-mem` plugin and its bundled components (hooks, worker service, SQLite/Chroma sync, viewer UI, search/planning skills). Issues in upstream dependencies should be reported to those projects directly, but feel free to flag them to us as well.

We take security seriously, will acknowledge valid reports within 48 hours, and aim to ship a fix in the next release.

## Security Measures

### Command Injection Prevention

Claude-mem executes system commands for git operations and process management. We have implemented comprehensive protections against command injection:

#### Safe Command Execution
- **Array-based Arguments:** All commands use array-based arguments to prevent shell interpretation
- **No Shell Execution:** `shell: false` is explicitly set for all spawn operations involving user input
- **Input Validation:** All user-controlled parameters are validated before use

#### Example Safe Pattern
```typescript
// ✅ SAFE: Array-based arguments with validation
if (!isValidBranchName(userInput)) {
  throw new Error('Invalid input');
}
spawnSync('git', ['checkout', userInput], { shell: false });

// ❌ UNSAFE: Never do this
execSync(`git checkout ${userInput}`);
```

### Input Validation

All user-controlled inputs are validated using whitelists and strict patterns:

- **Branch Names:** Must match `/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/` and not contain `..`
- **Port Numbers:** Must be numeric and within range 1024-65535
- **File Paths:** All paths are joined using `path.join()` to prevent traversal

### Process Management

- **PID File Protection:** Process IDs are stored in user's data directory (`~/.claude-mem/`)
- **Port Validation:** Worker port is validated before binding
- **Health Checks:** Worker health is verified before processing requests

### Privacy Controls

Claude-mem includes dual-tag system for content privacy:

- `<private>content</private>` - User-level privacy (prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level tag (prevents recursive storage)

Tags are stripped at the hook layer before data reaches worker/database.

## Security Audit History

### 2025-12-16: Command Injection Vulnerability (Issue #354)
- **Severity:** CRITICAL
- **Status:** RESOLVED
- **Affected Versions:** All versions prior to fix
- **Fixed In:** Current version
- **Vulnerabilities Found:** 3
- **Vulnerabilities Fixed:** 3

**Summary of Fixes:**
1. Replaced string interpolation with array-based arguments in `BranchManager.ts`
2. Added `isValidBranchName()` validation function
3. Removed unnecessary shell usage in `bun-path.ts`
4. Created comprehensive security test suite

## Security Best Practices for Contributors

### When Adding Command Execution

1. **NEVER use shell with user input:**
   ```typescript
   // ❌ NEVER
   execSync(`command ${userInput}`);
   spawn('command', [...], { shell: true });

   // ✅ ALWAYS
   spawnSync('command', [userInput], { shell: false });
   ```

2. **ALWAYS validate user input:**
   ```typescript
   if (!isValidInput(userInput)) {
     throw new Error('Invalid input');
   }
   ```

3. **Use array-based arguments:**
   ```typescript
   // ❌ NEVER
   execSync(`git ${command} ${arg}`);

   // ✅ ALWAYS
   spawnSync('git', [command, arg], { shell: false });
   ```

4. **Explicitly set shell: false:**
   ```typescript
   spawnSync('command', args, { shell: false });
   ```

### When Adding User Input

1. **Whitelist validation** over blacklist
2. **Strict regex patterns** for format validation
3. **Type checking** for expected data types
4. **Range validation** for numeric inputs
5. **Length limits** for string inputs

### Code Review Checklist

Before submitting a PR with command execution or user input handling:

- [ ] No `execSync` with string interpolation or template literals
- [ ] No `shell: true` when user input is involved
- [ ] All spawn/spawnSync calls use array arguments
- [ ] Input validation is present for all user-controlled parameters
- [ ] Security tests are added for new attack vectors
- [ ] Code follows the safe patterns described above

## Dependencies

We regularly audit dependencies for vulnerabilities:

- **npm audit:** Run before each release
- **Dependabot:** Enabled for automatic security updates
- **Manual Review:** Critical dependencies reviewed quarterly

## Data Storage

Claude-mem stores data locally in `~/.claude-mem/`:

- **Database:** SQLite3 at `~/.claude-mem/claude-mem.db`
- **Vector Store:** Chroma at `~/.claude-mem/chroma/`
- **Logs:** `~/.claude-mem/logs/`
- **Settings:** `~/.claude-mem/settings.json`

All claude-mem state files (database, vector store, logs, settings, supervisor and PID files) are written to the local user directory and are not uploaded by claude-mem itself. Claude-mem does not collect telemetry.

However, by design claude-mem invokes upstream model providers and optional integrations to do its work, so observation/transcript/prompt content can leave the machine through those channels:

- **Claude Agent SDK** (default summarization/observation path): sends prompts and transcript context to Anthropic's API.
- **Alternate providers** (`gemini`, `openrouter`): when configured, send the same context to those providers instead.
- **Chroma MCP / `chroma-mcp`**: when enabled, computes embeddings via the configured embedding backend, which may be a remote API depending on the user's chroma-mcp configuration.
- **OAuth / keychain reads**: claude-mem reads the Claude Code OAuth token from the platform-native credential store at spawn time. The token is injected into worker subprocesses but is not transmitted by claude-mem.
- **GitHub releases / npm registry**: version-check and self-update flows fetch metadata from public registries.

Review your provider/Chroma configuration in `~/.claude-mem/settings.json` and `~/.claude-mem/.env` before sending sensitive content. Use `<private>...</private>` tags to keep specific content out of the local store.

## Permissions

Claude-mem requires:

- **File System:** Read/write to `~/.claude-mem/` and `~/.claude/plugins/`
- **Network:** HTTP server on localhost (default port 37777)
- **Process Management:** Spawn worker processes, manage PIDs

No elevated privileges (root/administrator) are required.

## Secure Defaults

- **Worker Host:** Binds to `127.0.0.1` by default (localhost only)
- **Worker Port:** User-configurable, validates range 1024-65535
- **Log Level:** INFO by default (no sensitive data in logs)
- **Privacy Tags:** Auto-strips private content before storage

## Updates

Security patches are released as soon as possible after discovery. Users should:

1. Keep claude-mem updated to the latest version
2. Monitor GitHub releases for security announcements
3. Review [CHANGELOG.md](./CHANGELOG.md) for security-related changes

## Questions?

For security-related questions (non-vulnerabilities), please:

1. Review code comments in security-critical files
2. Open a GitHub Discussion (not an Issue) for general security questions
3. For sensitive questions, email **alex@cmem.ai**

---

**Last Updated:** 2026-05-03
**Last Audit:** 2025-12-16 (Issue #354)
**Next Scheduled Audit:** 2026-09-16
