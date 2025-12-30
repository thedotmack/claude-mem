# Save Observation Hook for Cursor (PowerShell)
# Captures MCP tool usage and shell command execution
# Maps to claude-mem's save-hook functionality

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
$workspaceRoot = Get-JsonField $input "workspace_roots[0]" ""

# Fallback to current directory if no workspace root
if (Test-IsEmpty $workspaceRoot) {
    $workspaceRoot = Get-Location
}

# Use conversation_id as session_id (stable across turns), fallback to generation_id
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

# Determine hook type and extract relevant data
$hookEvent = Get-JsonField $input "hook_event_name" ""

$payload = $null

if ($hookEvent -eq "afterMCPExecution") {
    # MCP tool execution
    $toolName = Get-JsonField $input "tool_name" ""

    if (Test-IsEmpty $toolName) {
        exit 0
    }

    # Extract tool_input and tool_response, defaulting to {} if invalid
    $toolInput = @{}
    $toolResponse = @{}

    if ($input.PSObject.Properties.Name -contains "tool_input") {
        $toolInput = $input.tool_input
        if ($null -eq $toolInput) { $toolInput = @{} }
    }

    if ($input.PSObject.Properties.Name -contains "result_json") {
        $toolResponse = $input.result_json
        if ($null -eq $toolResponse) { $toolResponse = @{} }
    }

    # Prepare observation payload
    $payload = @{
        contentSessionId = $sessionId
        tool_name = $toolName
        tool_input = $toolInput
        tool_response = $toolResponse
        cwd = $workspaceRoot
    }

} elseif ($hookEvent -eq "afterShellExecution") {
    # Shell command execution
    $command = Get-JsonField $input "command" ""

    if (Test-IsEmpty $command) {
        exit 0
    }

    $output = Get-JsonField $input "output" ""

    # Treat shell commands as "Bash" tool usage
    $toolInput = @{ command = $command }
    $toolResponse = @{ output = $output }

    $payload = @{
        contentSessionId = $sessionId
        tool_name = "Bash"
        tool_input = $toolInput
        tool_response = $toolResponse
        cwd = $workspaceRoot
    }

} else {
    exit 0
}

# Exit if payload creation failed
if ($null -eq $payload) {
    exit 0
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
