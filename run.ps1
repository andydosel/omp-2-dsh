# run.ps1 — build the dsh-plugin projects in dependency order, install them
# into the web profile (package-name resolution for the client bundles), then
# boot the DeepSeek Harness web profile with the compact-mode + vibe-mode
# overlay.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File run.ps1            # default boot
#   powershell -ExecutionPolicy Bypass -File run.ps1 --dump-config   # verify offline, no key needed
#   $env:DEEPSEEK_API_KEY = 'sk-...' ; powershell -ExecutionPolicy Bypass -File run.ps1
#
# Optional: -DshRoot <path> overrides the dsh monorepo location (default
# C:\Users\Vantage_XLST\Documents\dsh). Everything after the dsh invocation
# (e.g. --dump-config, app flags) is forwarded verbatim.
#
# Mechanism note: the patch rows now name PACKAGES (`@dsh-plugin/...`), so
# every plugin must be resolvable from the web profile directory. The
# install step runs `dsh plugin --profile web add <abs path>` (the official
# pnpm forwarder), which adds each package as a hoisted `link:` dependency in
# ~/.dsh/profiles/web — the same anchor client-modules uses to resolve
# `dsh.client` packages. mode-ui's client bundle (lib/client.js) must exist
# BEFORE the boot or client-modules raises MissingClientBundleError; the
# negative-cache rule means declaration/name changes require a restart.
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

# Build order matters: compact-mode depends on tree-engine via workspace:*;
# mode-ui's typecheck reads the sibling libs' built declarations; the other
# plugins are standalone. All seven must be built before the boot (the patch
# rows resolve by package name and the client bundles must exist).
foreach ($project in @(
    'dsh-tree-engine', 'dsh-compact-mode', 'dsh-vibe-mode',
    'dsh-tool-read-write', 'dsh-advisor', 'dsh-channel-wechat', 'dsh-mode-ui'
)) {
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

# Install every plugin (incl. mode-ui) into the web profile so the loader and
# client-modules can resolve the patch rows by package name. Idempotent:
# re-running re-adds the same link: dependencies ("Already up to date").
Write-Host "==> install plugins into the web profile (~/.dsh/profiles/web)"
Push-Location $DshRoot
try {
    foreach ($project in @(
        'dsh-tree-engine', 'dsh-compact-mode', 'dsh-vibe-mode',
        'dsh-tool-read-write', 'dsh-advisor', 'dsh-channel-wechat', 'dsh-mode-ui'
    )) {
        $dir = Join-Path $pluginRoot $project
        Write-Host "==> dsh plugin --profile web add $dir"
        pnpm dsh plugin --profile web add $dir
        if ($LASTEXITCODE -ne 0) { throw "profile install failed for $project" }
    }
} finally {
    Pop-Location
}

Write-Host "==> dsh web --patch $patchFile $($args -join ' ')"
Push-Location $DshRoot
try {
    pnpm dsh web --patch $patchFile @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
