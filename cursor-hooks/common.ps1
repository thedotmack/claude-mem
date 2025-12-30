# Common utility functions for Cursor hooks (PowerShell)
# Dot-source this file in hook scripts: . "$PSScriptRoot\common.ps1"
# Note: ErrorActionPreference should be set in each script, not globally here

# Get worker port from settings with validation
function Get-WorkerPort {
    $settingsPath = Join-Path $env:USERPROFILE ".claude-mem\settings.json"
    $port = 37777

    if (Test-Path $settingsPath) {
        try {
            $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
            if ($settings.CLAUDE_MEM_WORKER_PORT) {
                $parsedPort = [int]$settings.CLAUDE_MEM_WORKER_PORT
                if ($parsedPort -ge 1 -and $parsedPort -le 65535) {
                    $port = $parsedPort
                }
            }
        } catch {
            # Ignore parse errors, use default
        }
    }

    return $port
}

# Ensure worker is running with retries
function Test-WorkerReady {
    param(
        [int]$Port = 37777,
        [int]$MaxRetries = 75
    )

    for ($i = 0; $i -lt $MaxRetries; $i++) {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/readiness" -Method Get -TimeoutSec 1 -ErrorAction Stop
            return $true
        } catch {
            Start-Sleep -Milliseconds 200
        }
    }

    return $false
}

# Get project name from workspace root
function Get-ProjectName {
    param([string]$WorkspaceRoot)

    if ([string]::IsNullOrEmpty($WorkspaceRoot)) {
        return "unknown-project"
    }

    # Handle Windows drive root (e.g., "C:\")
    if ($WorkspaceRoot -match '^([A-Za-z]):\\?$') {
        return "drive-$($Matches[1].ToUpper())"
    }

    $projectName = Split-Path $WorkspaceRoot -Leaf
    if ([string]::IsNullOrEmpty($projectName)) {
        return "unknown-project"
    }

    return $projectName
}

# URL encode a string
function Get-UrlEncodedString {
    param([string]$String)

    if ([string]::IsNullOrEmpty($String)) {
        return ""
    }

    return [System.Uri]::EscapeDataString($String)
}

# Check if string is empty or null
function Test-IsEmpty {
    param([string]$String)

    return [string]::IsNullOrEmpty($String) -or $String -eq "null" -or $String -eq "empty"
}

# Safely read JSON from stdin with error handling
function Read-JsonInput {
    try {
        $input = [Console]::In.ReadToEnd()
        if ([string]::IsNullOrEmpty($input)) {
            return @{}
        }
        return $input | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return @{}
    }
}

# Safely get JSON field with fallback
function Get-JsonField {
    param(
        [PSObject]$Json,
        [string]$Field,
        [string]$Fallback = ""
    )

    if ($null -eq $Json) {
        return $Fallback
    }

    # Handle array access syntax (e.g., "workspace_roots[0]")
    if ($Field -match '^(.+)\[(\d+)\]$') {
        $arrayField = $Matches[1]
        $index = [int]$Matches[2]

        if ($Json.PSObject.Properties.Name -contains $arrayField) {
            $array = $Json.$arrayField
            if ($null -ne $array -and $array.Count -gt $index) {
                $value = $array[$index]
                if (-not (Test-IsEmpty $value)) {
                    return $value
                }
            }
        }
        return $Fallback
    }

    # Simple field access
    if ($Json.PSObject.Properties.Name -contains $Field) {
        $value = $Json.$Field
        if (-not (Test-IsEmpty $value)) {
            return $value
        }
    }

    return $Fallback
}

# Convert object to JSON string (compact)
function ConvertTo-JsonCompact {
    param([object]$Object)

    return $Object | ConvertTo-Json -Compress -Depth 10
}

# Send HTTP POST request (fire-and-forget style)
function Send-HttpPostAsync {
    param(
        [string]$Uri,
        [object]$Body
    )

    try {
        $bodyJson = ConvertTo-JsonCompact $Body
        Start-Job -ScriptBlock {
            param($u, $b)
            try {
                Invoke-RestMethod -Uri $u -Method Post -Body $b -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
            } catch {}
        } -ArgumentList $Uri, $bodyJson | Out-Null
    } catch {
        # Ignore errors - fire and forget
    }
}

# Send HTTP POST request (synchronous)
function Send-HttpPost {
    param(
        [string]$Uri,
        [object]$Body
    )

    try {
        $bodyJson = ConvertTo-JsonCompact $Body
        Invoke-RestMethod -Uri $u -Method Post -Body $bodyJson -ContentType "application/json" -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
    } catch {
        # Ignore errors
    }
}

# Get HTTP response
function Get-HttpResponse {
    param(
        [string]$Uri,
        [int]$TimeoutSec = 5
    )

    try {
        return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec $TimeoutSec -ErrorAction Stop
    } catch {
        return $null
    }
}
