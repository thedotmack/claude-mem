param([int]$Samples = 3)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'profile-claude-mem-hooks.cjs'
& $node $script --samples $Samples
exit $LASTEXITCODE
