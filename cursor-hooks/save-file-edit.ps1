# Save File Edit Hook for Cursor (PowerShell)
# Captures file edits made by the agent
# Maps file edits to claude-mem observations

$ErrorActionPreference = "SilentlyContinue"

# Source common utilities
$commonPath = Join-Path $PSScriptRoot "common.ps1"
if (Test-Path $commonPath) {
    . $commonPath
} else {
    Write-Warning "common.ps1 not found, using fallback functions"
    exit 0
}

# Read JSON input from stdin with error handling
$input = Read-JsonInput

# Extract common fields with safe fallbacks
$conversationId = Get-JsonField $input "conversation_id" ""
$generationId = Get-JsonField $input "generation_id" ""
$filePath = Get-JsonField $input "file_path" ""
$workspaceRoot = Get-JsonField $input "workspace_roots[0]" ""

# Fallback to current directory if no workspace root
if (Test-IsEmpty $workspaceRoot) {
    $workspaceRoot = Get-Location
}

# Exit if no file_path
if (Test-IsEmpty $filePath) {
    exit 0
}

# Use conversation_id as session_id, fallback to generation_id
$sessionId = $conversationId
if (Test-IsEmpty $sessionId) {
    $sessionId = $generationId
}

# Exit if no session_id available
if (Test-IsEmpty $sessionId) {
    exit 0
}

# Get worker port from settings with validation
$workerPort = Get-WorkerPort

# Extract edits array, defaulting to [] if invalid
$edits = @()
if ($input.PSObject.Properties.Name -contains "edits") {
    $edits = $input.edits
    if ($null -eq $edits -or -not ($edits -is [array])) {
        $edits = @()
    }
}

# Exit if no edits
if ($edits.Count -eq 0) {
    exit 0
}

# Create a summary of the edits for the observation
$editSummaries = @()
foreach ($edit in $edits) {
    $oldStr = ""
    $newStr = ""

    if ($edit.PSObject.Properties.Name -contains "old_string") {
        $oldStr = $edit.old_string
        if ($oldStr.Length -gt 50) {
            $oldStr = $oldStr.Substring(0, 50) + "..."
        }
    }

    if ($edit.PSObject.Properties.Name -contains "new_string") {
        $newStr = $edit.new_string
        if ($newStr.Length -gt 50) {
            $newStr = $newStr.Substring(0, 50) + "..."
        }
    }

    $editSummaries += "$oldStr → $newStr"
}

$editSummary = $editSummaries -join "; "
if ([string]::IsNullOrEmpty($editSummary)) {
    $editSummary = "File edited"
}

# Treat file edits as a "write_file" tool usage
$toolInput = @{
    file_path = $filePath
    edits = $edits
}

$toolResponse = @{
    success = $true
    summary = $editSummary
}

$payload = @{
    contentSessionId = $sessionId
    tool_name = "write_file"
    tool_input = $toolInput
    tool_response = $toolResponse
    cwd = $workspaceRoot
}

# Ensure worker is running (with retries like claude-mem hooks)
if (-not (Test-WorkerReady -Port $workerPort)) {
    # Worker not ready - exit gracefully (don't block Cursor)
    exit 0
}

# Send observation to claude-mem worker (fire-and-forget)
$uri = "http://127.0.0.1:$workerPort/api/sessions/observations"

try {
    $bodyJson = ConvertTo-JsonCompact $payload
    Invoke-RestMethod -Uri $uri -Method Post -Body $bodyJson -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {
    # Ignore errors - don't block Cursor
}

exit 0
