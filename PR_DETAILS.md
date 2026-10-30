## PR Title
security: replace shell:true with array-based cmd.exe /c in launcher

## PR Description
### Summary
Fixes command-injection vulnerability in `claude-mem-launcher.ts` where `shell: true` combined with manual string interpolation (`quote()` + `.join(' ')`) allowed arbitrary command execution on Windows.

### Change
- Removed `spawnOptions.shell = true`
- Removed unsafe `quote()` string interpolation
- Replaced with safe array-based args: `cmd.exe` `/c` passed executable and arguments directly (`spawnArguments = ['/c', ...]`)

### Security Impact
Prevents potential command injection via manipulated `.cmd`/`.bat` paths or user-controlled arguments being interpreted by the Windows shell.

### Verification
- File: `src/launcher/claude-mem-launcher.ts`
- Commit: `842939c3`
- Lines changed: 4 insertions, 4 deletions
