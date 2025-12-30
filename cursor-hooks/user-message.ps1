# User Message Hook for Cursor (PowerShell)
# Displays context information to the user
# Maps to claude-mem's user-message-hook functionality
# Note: Cursor doesn't have a direct equivalent, but we can output to stderr
# for visibility in Cursor's output channels
#
# This is an OPTIONAL hook. It can be added to beforeSubmitPrompt if desired,
# but may be verbose since it runs on every prompt submission.

$ErrorActionPreference = "SilentlyContinue"

# Read JSON input from stdin (if any)
$inputJson = $null
try {
    $inputText = [Console]::In.ReadToEnd()
    if (-not [string]::IsNullOrEmpty($inputText)) {
        $inputJson = $inputText | ConvertFrom-Json -ErrorAction SilentlyContinue
    }
} catch {
    $inputJson = $null
}

# Extract workspace root
$workspaceRoot = ""
if ($null -ne $inputJson -and $inputJson.PSObject.Properties.Name -contains "workspace_roots") {
    $wsRoots = $inputJson.workspace_roots
    if ($null -ne $wsRoots -and $wsRoots.Count -gt 0) {
        $workspaceRoot = $wsRoots[0]
    }
}

if ([string]::IsNullOrEmpty($workspaceRoot)) {
    $workspaceRoot = Get-Location
}

# Get project name
$projectName = Split-Path $workspaceRoot -Leaf
if ([string]::IsNullOrEmpty($projectName)) {
    $projectName = "unknown-project"
}

# Get worker port from settings
$settingsPath = Join-Path $env:USERPROFILE ".claude-mem\settings.json"
$workerPort = 37777

if (Test-Path $settingsPath) {
    try {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
        if ($settings.CLAUDE_MEM_WORKER_PORT) {
            $workerPort = [int]$settings.CLAUDE_MEM_WORKER_PORT
        }
    } catch {
        # Use default
    }
}

# Ensure worker is running
$maxRetries = 75
$workerReady = $false

for ($i = 0; $i -lt $maxRetries; $i++) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$workerPort/api/readiness" -Method Get -TimeoutSec 1 -ErrorAction Stop
        $workerReady = $true
        break
    } catch {
        Start-Sleep -Milliseconds 200
    }
}

# If worker not ready, exit silently
if (-not $workerReady) {
    exit 0
}

# Fetch formatted context from worker API (with colors)
$projectEncoded = [System.Uri]::EscapeDataString($projectName)
$contextUrl = "http://127.0.0.1:$workerPort/api/context/inject?project=$projectEncoded&colors=true"

$output = $null
try {
    $output = Invoke-RestMethod -Uri $contextUrl -Method Get -TimeoutSec 5 -ErrorAction Stop
} catch {
    $output = $null
}

# Output to stderr for visibility (parity with user-message-hook.ts)
# Note: Cursor may not display stderr the same way Claude Code does,
# but this is the best we can do without direct UI integration
if (-not [string]::IsNullOrEmpty($output)) {
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("📝 Claude-Mem Context Loaded")
    [Console]::Error.WriteLine("   ℹ️  Viewing context from past sessions")
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine($output)
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("💡 Tip: Wrap content with <private> ... </private> to prevent storing sensitive information.")
    [Console]::Error.WriteLine("💬 Community: https://discord.gg/J4wttp9vDu")
    [Console]::Error.WriteLine("📺 Web Viewer: http://localhost:$workerPort/")
    [Console]::Error.WriteLine("")
}

exit 0
