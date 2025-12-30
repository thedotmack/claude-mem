# Session Summary Hook for Cursor (stop) - PowerShell
# Called when agent loop ends
#
# This hook:
# 1. Generates session summary
# 2. Updates context file for next session
#
# Output: Empty JSON {} or {"followup_message": "..."} for auto-iteration

$ErrorActionPreference = "SilentlyContinue"

# Source common utilities
$commonPath = Join-Path $PSScriptRoot "common.ps1"
if (Test-Path $commonPath) {
    . $commonPath
} else {
    Write-Output '{}'
    exit 0
}

# Read JSON input from stdin with error handling
$input = Read-JsonInput

# Extract common fields with safe fallbacks
$conversationId = Get-JsonField $input "conversation_id" ""
$generationId = Get-JsonField $input "generation_id" ""
$workspaceRoot = Get-JsonField $input "workspace_roots[0]" ""
$status = Get-JsonField $input "status" "completed"

# Fallback workspace to current directory
if (Test-IsEmpty $workspaceRoot) {
    $workspaceRoot = Get-Location
}

# Get project name
$projectName = Get-ProjectName $workspaceRoot

# Use conversation_id as session_id, fallback to generation_id
$sessionId = $conversationId
if (Test-IsEmpty $sessionId) {
    $sessionId = $generationId
}

# Exit if no session_id available
if (Test-IsEmpty $sessionId) {
    Write-Output '{}'
    exit 0
}

# Get worker port from settings with validation
$workerPort = Get-WorkerPort

# Ensure worker is running (with retries)
if (-not (Test-WorkerReady -Port $workerPort)) {
    Write-Output '{}'
    exit 0
}

# 1. Request summary generation (fire-and-forget)
# Note: Cursor doesn't provide transcript_path like Claude Code does,
# so we can't extract last_user_message and last_assistant_message.
$summaryPayload = @{
    contentSessionId = $sessionId
    last_user_message = ""
    last_assistant_message = ""
}

$summaryUri = "http://127.0.0.1:$workerPort/api/sessions/summarize"
Send-HttpPostAsync -Uri $summaryUri -Body $summaryPayload

# 2. Update context file for next session
# Fetch fresh context (includes observations from this session)
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

# Output empty JSON - no followup message
Write-Output '{}'
exit 0
