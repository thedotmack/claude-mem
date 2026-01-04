# Session Initialization Hook for Cursor (PowerShell)
# Maps to claude-mem's new-hook functionality
# Initializes a new session when a prompt is submitted
#
# NOTE: This hook runs as part of beforeSubmitPrompt and MUST output valid JSON
# with at least {"continue": true} to allow prompt submission.

$ErrorActionPreference = "SilentlyContinue"

# Source common utilities
$commonPath = Join-Path $PSScriptRoot "common.ps1"
if (Test-Path $commonPath) {
    . $commonPath
} else {
    # Fallback - output continue and exit
    Write-Output '{"continue": true}'
    exit 0
}

# Read JSON input from stdin with error handling
$input = Read-JsonInput

# Extract common fields with safe fallbacks
$conversationId = Get-JsonField $input "conversation_id" ""
$generationId = Get-JsonField $input "generation_id" ""
$prompt = Get-JsonField $input "prompt" ""
$workspaceRoot = Get-JsonField $input "workspace_roots[0]" ""

# Fallback to current directory if no workspace root
if (Test-IsEmpty $workspaceRoot) {
    $workspaceRoot = Get-Location
}

# Get project name from workspace root
$projectName = Get-ProjectName $workspaceRoot

# Use conversation_id as session_id (stable across turns), fallback to generation_id
$sessionId = $conversationId
if (Test-IsEmpty $sessionId) {
    $sessionId = $generationId
}

# Exit gracefully if no session_id available (still allow prompt)
if (Test-IsEmpty $sessionId) {
    Write-Output '{"continue": true}'
    exit 0
}

# Get worker port from settings with validation
$workerPort = Get-WorkerPort

# Ensure worker is running (with retries like claude-mem hooks)
if (-not (Test-WorkerReady -Port $workerPort)) {
    # Worker not ready - still allow prompt to continue
    Write-Output '{"continue": true}'
    exit 0
}

# Strip leading slash from commands for memory agent (parity with new-hook.ts)
# /review 101 → review 101 (more semantic for observations)
$cleanedPrompt = $prompt
if (-not [string]::IsNullOrEmpty($prompt) -and $prompt.StartsWith("/")) {
    $cleanedPrompt = $prompt.Substring(1)
}

# Initialize session via HTTP - handles DB operations and privacy checks
$payload = @{
    contentSessionId = $sessionId
    project = $projectName
    prompt = $cleanedPrompt
}

# Send request to worker (fire-and-forget, don't wait for response)
$uri = "http://127.0.0.1:$workerPort/api/sessions/init"
Send-HttpPostAsync -Uri $uri -Body $payload

# Always allow prompt to continue
Write-Output '{"continue": true}'
exit 0
