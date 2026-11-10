import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOWS_USER_PATH_APPEND_SCRIPT } from '../../src/launcher/install-launcher.js';

const enabled = process.platform === 'win32' && process.env.CLAUDE_MEM_TEST_WINDOWS_PATH === '1';

describe.skipIf(!enabled)('Windows user Path script against the registry', () => {
  it('refuses an empty directory and preserves raw Path values and backups when appending', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'claude-mem-user-path-'));
    const script = join(scratch, 'append.ps1');
    const harness = join(scratch, 'check.ps1');
    writeFileSync(script, WINDOWS_USER_PATH_APPEND_SCRIPT);
    writeFileSync(harness, String.raw`
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$names = @('Path', 'CLAUDE_MEM_PATH_BROADCAST')
$original = @{}
foreach ($name in $names) {
  $present = $key.GetValueNames() -contains $name
  $original[$name] = @{
    present = $present
    value = if ($present) { $key.GetValue($name, '', 'DoNotExpandEnvironmentNames') } else { $null }
    kind = if ($present) { $key.GetValueKind($name) } else { $null }
  }
}
$backupDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'claude-mem'
$backup = Join-Path $backupDir 'user-path.bak'
$hadBackupDir = Test-Path -LiteralPath $backupDir
$hadBackup = Test-Path -LiteralPath $backup
$backupBytes = if ($hadBackup) { [IO.File]::ReadAllBytes($backup) } else { $null }
$cases = @()
function Invoke-Append($directory) {
  $env:CLAUDE_MEM_LAUNCHER_DIRECTORY = $directory
  $stdout = Join-Path $env:CMEM_PATH_SCRATCH 'stdout.txt'
  $stderr = Join-Path $env:CMEM_PATH_SCRATCH 'stderr.txt'
  $child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList @('-NoProfile', '-NonInteractive', '-File', ('"' + $env:CMEM_PATH_SCRIPT + '"')) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -NoNewWindow
  if (-not $child.WaitForExit(10000)) {
    $child.Kill()
    $child.WaitForExit()
    throw 'Path script did not exit within 10 seconds'
  }
  @{
    code = $child.ExitCode
    output = [IO.File]::ReadAllText($stdout).Trim()
    path = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    kind = $key.GetValueKind('Path').ToString()
    broadcastPresent = $key.GetValueNames() -contains 'CLAUDE_MEM_PATH_BROADCAST'
    backup = [IO.File]::ReadAllText($backup)
  }
}
try {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  [IO.File]::WriteAllText($backup, 'last good backup')
  $key.SetValue('Path', '%USERPROFILE%\existing', [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $key.SetValue('CLAUDE_MEM_PATH_BROADCAST', 'original broadcast')
  $cases += Invoke-Append ''
  $cases += Invoke-Append $env:CMEM_PATH_DIRECTORY
  $cases += Invoke-Append $env:CMEM_PATH_DIRECTORY
  $key.SetValue('Path', '', [Microsoft.Win32.RegistryValueKind]::ExpandString)
  $cases += Invoke-Append $env:CMEM_PATH_DIRECTORY
} finally {
  foreach ($name in $names) {
    if ($original[$name].present) {
      $key.SetValue($name, $original[$name].value, $original[$name].kind)
    } else {
      $key.DeleteValue($name, $false)
    }
  }
  $key.Dispose()
  if ($hadBackup) { [IO.File]::WriteAllBytes($backup, $backupBytes) }
  else { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  if (-not $hadBackupDir -and -not (Get-ChildItem -LiteralPath $backupDir -Force)) {
    Remove-Item -LiteralPath $backupDir -Force
  }
}
ConvertTo-Json -InputObject $cases -Depth 4 -Compress
`);
    try {
      const directory = join(scratch, 'launcher');
      const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', harness], {
        encoding: 'utf8',
        env: { ...process.env, CMEM_PATH_SCRIPT: script, CMEM_PATH_DIRECTORY: directory, CMEM_PATH_SCRATCH: scratch },
        timeout: 60_000,
      });
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      const cases = JSON.parse(run.stdout);
      expect(cases).toEqual([
        {
          code: 1, output: 'missing-launcher-directory', path: '%USERPROFILE%\\existing',
          kind: 'ExpandString', broadcastPresent: true, backup: 'last good backup',
        },
        {
          code: 0, output: 'added', path: `%USERPROFILE%\\existing;${directory}`,
          kind: 'ExpandString', broadcastPresent: false, backup: '%USERPROFILE%\\existing',
        },
        {
          code: 0, output: 'present', path: `%USERPROFILE%\\existing;${directory}`,
          kind: 'ExpandString', broadcastPresent: false, backup: '%USERPROFILE%\\existing',
        },
        {
          code: 0, output: 'added', path: directory,
          kind: 'ExpandString', broadcastPresent: false, backup: '%USERPROFILE%\\existing',
        },
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 75_000);
});
