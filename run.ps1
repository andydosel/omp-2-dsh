# run.ps1 — build the dsh-plugin projects in dependency order, then boot the
# DeepSeek Harness web profile with the compact-mode + vibe-mode overlay.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File run.ps1            # default boot
#   powershell -ExecutionPolicy Bypass -File run.ps1 --dump-config   # verify offline, no key needed
#   $env:DEEPSEEK_API_KEY = 'sk-...' ; powershell -ExecutionPolicy Bypass -File run.ps1
#
# Optional: -DshRoot <path> overrides the dsh monorepo location (default
# C:\Users\Vantage_XLST\Documents\dsh). Everything after the dsh invocation
# (e.g. --dump-config, app flags) is forwarded verbatim.
param(
    [string]$DshRoot = 'C:\Users\Vantage_XLST\Documents\dsh'
)

$ErrorActionPreference = 'Stop'

$profileDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot  = Split-Path -Parent $profileDir        # .../dsh-plugin/plugin
$patchFile   = Join-Path $profileDir 'cordis.patch.yml'

if (-not (Test-Path $DshRoot)) {
    throw "dsh monorepo not found at $DshRoot (pass -DshRoot <path>)"
}

# Build order matters: compact-mode depends on tree-engine via workspace:*.
foreach ($project in @('dsh-tree-engine', 'dsh-compact-mode', 'dsh-vibe-mode')) {
    $dir = Join-Path $pluginRoot $project
    if (-not (Test-Path (Join-Path $dir 'package.json'))) {
        throw "plugin project not found: $dir"
    }
    Write-Host "==> build $project"
    Push-Location $dir
    try {
        pnpm run build
        if ($LASTEXITCODE -ne 0) { throw "build failed for $project" }
    } finally {
        Pop-Location
    }
}

Write-Host "==> dsh web --patch $patchFile $($args -join ' ')"
Push-Location $DshRoot
try {
    pnpm dsh web --patch $patchFile @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
