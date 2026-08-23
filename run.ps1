# run.ps1 — build the dsh-plugin projects in dependency order, install them
# into the web profile (package-name resolution for the client bundles), then
# boot the DeepSeek Harness web profile with the compact-mode + vibe-mode
# overlay.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File run.ps1            # default boot
#   powershell -ExecutionPolicy Bypass -File run.ps1 -Fast      # daily path
#   powershell -ExecutionPolicy Bypass -File run.ps1 --dump-config   # verify offline, no key needed
#   $env:DEEPSEEK_API_KEY = 'sk-...' ; powershell -ExecutionPolicy Bypass -File run.ps1
#
# Optional: -DshRoot <path> overrides the dsh monorepo location (default
# C:\Users\Vantage_XLST\Documents\dsh). Everything after the dsh invocation
# (e.g. --dump-config, app flags) is forwarded verbatim.
#
# -Fast: the daily/lean path. Skips the build of any plugin whose built host
# entry (and client bundle, for the two client-faced plugins) is already newer
# than its source, and skips `dsh plugin --profile web add` for any plugin
# already resolvable from the web profile node_modules. With everything fresh it
# falls through to a single boot — the same "no build / no install" outcome as
# the release consumer's start.ps1.
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
    [string]$DshRoot = 'C:\Users\Vantage_XLST\Documents\dsh',
    [switch]$Fast
)

$ErrorActionPreference = 'Stop'

$profileDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginRoot  = Split-Path -Parent $profileDir        # .../dsh-plugin/plugin
$patchFile   = Join-Path $profileDir 'cordis.patch.yml'

# ConvertFrom-Json yields PSCustomObject, whose nested objects don't support
# hashtable indexer access reliably in PS 5.1. Convert recursively to hashtables.
function ConvertTo-Hash([object]$o) {
    if ($null -eq $o) { return $o }
    if ($o -is [System.Collections.IDictionary]) {
        $h = @{}
        foreach ($k in $o.Keys) { $h[$k] = ConvertTo-Hash $o[$k] }
        return $h
    }
    if ($o -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $o.PSObject.Properties) { $h[$p.Name] = ConvertTo-Hash $p.Value }
        return $h
    }
    return $o
}

# Resolve a package's runnable host entry (exports["."] wins, else main).
function Resolve-PluginEntry {
    param([string]$PackageDir, $Manifest)
    $entry = ''
    $exports = $Manifest['exports']
    $dot = $null
    if ($null -ne $exports) {
        if ($exports -is [System.Collections.IDictionary]) { $dot = $exports['.'] }
    }
    if ($null -ne $dot) {
        if ($dot -is [System.Collections.IDictionary]) {
            if ($dot['default']) { $entry = [string]$dot['default'] }
            elseif ($dot['import']) { $entry = [string]$dot['import'] }
        } else {
            $entry = [string]$dot
        }
    }
    if (-not $entry -and $Manifest -and $Manifest['main']) { $entry = [string]$Manifest['main'] }
    if (-not $entry) { return '' }
    $rel = $entry -replace '^\./', ''
    if ($rel -notlike 'lib/*') { $rel = Join-Path 'lib' $rel }
    return Join-Path $PackageDir $rel
}

# True when the built artifacts are present and at least as new as the newest
# source/config that feeds the build. Used by -Fast to decide "no rebuild".
function Test-PluginFresh {
    param([string]$Dir, [string[]]$Artifacts)
    foreach ($a in $Artifacts) {
        if (-not (Test-Path $a)) { return $false }
    }
    $sourceRoots = @()
    foreach ($sub in @('src', 'client')) {
        $p = Join-Path $Dir $sub
        if (Test-Path $p) { $sourceRoots += $p }
    }
    $config = Get-ChildItem -Path $Dir -File -Include 'tsconfig*.json', 'tsdown*.ts', 'package.json' -ErrorAction SilentlyContinue
    $sources = @()
    foreach ($root in $sourceRoots) {
        $sources += Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue
    }
    $sources += $config
    $newestSource = $sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $newestSource) { return $true }   # no source -> nothing to rebuild
    $newestArtifact = $Artifacts | ForEach-Object { Get-Item $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $newestArtifact) { return $false }
    return $newestArtifact.LastWriteTime -ge $newestSource.LastWriteTime
}

if (-not (Test-Path $DshRoot)) {
    throw "dsh monorepo not found at $DshRoot (pass -DshRoot <path>)"
}

# Build order matters: compact-mode depends on tree-engine via workspace:*;
# mode-ui's typecheck reads the sibling libs' built declarations; the other
# plugins are standalone. All seven must be built before the boot (the patch
# rows resolve by package name and the client bundles must exist).
$plugins       = @(
    'dsh-tree-engine', 'dsh-compact-mode', 'dsh-vibe-mode',
    'dsh-tool-read-write', 'dsh-advisor', 'dsh-channel-wechat', 'dsh-mode-ui'
)
$clientPlugins = @('dsh-vibe-mode', 'dsh-mode-ui')

# -Fast only rebuilds a plugin when it is actually stale; otherwise fall through.
$buildPlan = @()
foreach ($project in $plugins) {
    $dir = Join-Path $pluginRoot $project
    if (-not (Test-Path (Join-Path $dir 'package.json'))) {
        throw "plugin project not found: $dir"
    }
    $needsBuild = $true
    if ($Fast) {
        $manifest = ConvertTo-Hash (Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json)
        $artifact = Resolve-PluginEntry $dir $manifest
        $artifacts = @($artifact)
        if ($clientPlugins -contains $project) {
            $artifacts += (Join-Path $dir 'lib\client.js')
        }
        $needsBuild = -not (Test-PluginFresh $dir $artifacts)
    }
    if ($needsBuild) { $buildPlan += $project }
}

foreach ($project in $buildPlan) {
    $dir = Join-Path $pluginRoot $project
    Write-Host "==> build $project"
    Push-Location $dir
    try {
        pnpm run build
        if ($LASTEXITCODE -ne 0) { throw "build failed for $project" }
    } finally {
        Pop-Location
    }
}
if ($Fast -and $buildPlan.Count -eq 0) {
    Write-Host "==> -Fast: all plugins fresh, skipping build"
}

# Install every plugin into the web profile so the loader and client-modules can
# resolve the patch rows by package name. Idempotent: re-running re-adds the
# same link: dependencies ("Already up to date"). -Fast skips plugins that are
# already resolvable from the profile node_modules.
$installPlan = @()
$webProfilePluginDir = Join-Path $HOME '.dsh\profiles\web\node_modules\@dsh-plugin'
foreach ($project in $plugins) {
    $dir = Join-Path $pluginRoot $project; $pkgName = (Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json).name; $unscoped = $pkgName -replace '^@dsh-plugin/', ''; $already = Test-Path (Join-Path $webProfilePluginDir $unscoped)
    if ($Fast -and $already) { continue }
    $installPlan += $project
}

if ($installPlan.Count -gt 0) {
    Write-Host "==> install plugins into the web profile (~/.dsh/profiles/web)"
    Push-Location $DshRoot
    try {
        foreach ($project in $installPlan) {
            $dir = Join-Path $pluginRoot $project
            Write-Host "==> dsh plugin --profile web add $dir"
            pnpm dsh plugin --profile web add $dir
            if ($LASTEXITCODE -ne 0) { throw "profile install failed for $project" }
        }
    } finally {
        Pop-Location
    }
} elseif ($Fast) {
    Write-Host "==> -Fast: all plugins already installed, skipping install"
}

Write-Host "==> dsh web --patch $patchFile $($args -join ' ')"
Push-Location $DshRoot
try {
    pnpm dsh web --patch $patchFile @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
