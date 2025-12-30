# Context Hook for Cursor (beforeSubmitPrompt) - PowerShell
# Ensures worker is running and refreshes context before prompt submission
#
# Context is updated in BOTH places:
# - Here (beforeSubmitPrompt): Fresh context at session start
# - stop hook (session-summary.ps1): Updated context after observations are made

$ErrorActionPreference = "SilentlyContinue"

# Source common utilities
$commonPath = Join-Path $PSScriptRoot "common.ps1"
if (Test-Path $commonPath) {
    . $commonPath
} else {
    Write-Output '{"continue": true}'
    exit 0
}

# Read JSON input from stdin
$input = Read-JsonInput

# Extract workspace root
$workspaceRoot = Get-JsonField $input "workspace_roots[0]" ""
if (Test-IsEmpty $workspaceRoot) {
    $workspaceRoot = Get-Location
}

# Get project name
$projectName = Get-ProjectName $workspaceRoot

# Get worker port from settings
$workerPort = Get-WorkerPort

# Ensure worker is running (with retries)
# This primes the worker before the session starts
if (Test-WorkerReady -Port $workerPort) {
    # Refresh context file with latest observations
    $projectEncoded = Get-UrlEncodedString $projectName
    $contextUri = "http://127.0.0.1:$workerPort/api/context/inject?project=$projectEncoded"
    $context = Get-HttpResponse -Uri $contextUri

    if (-not [string]::IsNullOrEmpty($context)) {
        $rulesDir = Join-Path $workspaceRoot ".cursor\rules"
        $rulesFile = Join-Path $rulesDir "claude-mem-context.mdc"

        # Create rules directory if it doesn't exist
        if (-not (Test-Path $rulesDir)) {
            New-Item -ItemType Directory -Path $rulesDir -Force | Out-Null
        }

        # Write context as a Cursor rule with alwaysApply: true
        $ruleContent = @"
---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

The following context is from claude-mem, a persistent memory system that tracks your coding sessions.

$context

---
*Updated after last session. Use claude-mem's MCP search tools for more detailed queries.*
"@

        Set-Content -Path $rulesFile -Value $ruleContent -Encoding UTF8 -Force
    }
}

# Allow prompt to continue
Write-Output '{"continue": true}'
exit 0
