param([int]$Samples = 3)
$ErrorActionPreference = 'Stop'
$node = 'C:\Program Files\nodejs\node.exe'
$script = Join-Path $PSScriptRoot 'profile-claude-mem-hooks.cjs'
& $node $script --samples $Samples
exit $LASTEXITCODE
