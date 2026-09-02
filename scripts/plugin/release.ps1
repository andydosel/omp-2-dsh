# release.ps1 — build the dsh plugin suite in dependency order and package it as
# one GitHub-Release-ready zip asset (dsh-suite-<version>.zip).
#
# WHY a zip at all: dsh loads plugins BY PACKAGE NAME from the profile dir and
# imports each plugin's built host entry (plus `lib/client.js` for the two
# client-faced plugins: vibe-mode, mode-ui). `lib/` is gitignored in this repo,
# so git cannot carry the built code — a GitHub Release asset is the only way a
# consumer gets real, runnable plugins without building from source.
#
# Each plugin is shipped as a self-contained resolvable package:
#   @dsh-plugin/<name>/package.json  +  @dsh-plugin/<name>/lib/**
# alongside the profile overlay (cordis.patch.yml), the agent preset
# (agent-presets/standard-rw/), the consumer setup.ps1/start.ps1, and a README.
#
# Usage (Windows PowerShell):
#   powershell -ExecutionPolicy Bypass -File release.ps1
#   powershell -ExecutionPolicy Bypass -File release.ps1 -Version 0.1.0 -OutputDir .\release
#
# This only builds + packages. It does NOT push a tag or create a Release; the
# documented (not executed) commands are printed at the end:
#   git tag v<version> && git push origin v<version>
#   gh release create v<version> .\release\dsh-suite-<version>.zip --title "dsh-suite <version>" --notes "..."
param(
    [string]$Version = '',
    [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'

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

# Resolve a package's runnable host entry (exports["."] wins, else main). Node
# imports the package by name, so this built file must exist for the loader.
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

$pluginRoot  = $PSScriptRoot                       # .../dsh-plugin/plugin
$profileDir  = Join-Path $pluginRoot 'profile-main'
$patchFile   = Join-Path $profileDir 'cordis.patch.yml'
$versionFile = Join-Path $pluginRoot 'VERSION'

# ── single source of truth for the suite version ────────────────────────────
if (-not $Version) {
    if (-not (Test-Path $versionFile)) {
        throw "VERSION file not found at '$versionFile'. Create it with a bare version (e.g. '0.1.0') or pass -Version <v>."
    }
    $Version = (Get-Content $versionFile -Raw).Trim()
    if (-not $Version) { throw "VERSION file at '$versionFile' is empty." }
}
if (-not $OutputDir) { $OutputDir = Join-Path $pluginRoot 'release' }

if (-not (Test-Path $patchFile)) { throw "patch not found at '$patchFile'." }
foreach ($f in @('setup.ps1', 'start.ps1', 'README.md')) {
    if (-not (Test-Path (Join-Path $pluginRoot $f))) {
        throw "missing consumer file '$f' beside release.ps1 (it ships inside the zip)."
    }
}

# Build order matters: compact-mode depends on tree-engine (workspace:*), the
# rest are standalone; vibe-mode and mode-ui additionally need lib/client.js.
$plugins       = @(
    'dsh-tree-engine', 'dsh-compact-mode', 'dsh-vibe-mode',
    'dsh-tool-read-write', 'dsh-advisor', 'dsh-channel-wechat', 'dsh-mode-ui'
)
$clientPlugins = @('dsh-vibe-mode', 'dsh-mode-ui')

Write-Host "==> dsh-suite release v$Version"

# ── 1) build every plugin in dependency order ───────────────────────────────
foreach ($p in $plugins) {
    $dir = Join-Path $pluginRoot $p
    if (-not (Test-Path (Join-Path $dir 'package.json'))) { throw "plugin project not found: $dir" }
    Write-Host "==> build $p"
    Push-Location $dir
    try {
        pnpm run build
        if ($LASTEXITCODE -ne 0) { throw "build failed for $p (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

# ── 2) stage the distribution tree ──────────────────────────────────────────
$suiteDir = "dsh-suite-$Version"
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-release-staging-" + [guid]::NewGuid().ToString('N'))
$pkgDir  = Join-Path $staging $suiteDir
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null

$distPlugins = Join-Path $pkgDir '@dsh-plugin'
New-Item -ItemType Directory -Force -Path $distPlugins | Out-Null

foreach ($p in $plugins) {
    $src = Join-Path $pluginRoot $p
    $dst = Join-Path $distPlugins $p
    New-Item -ItemType Directory -Force -Path $dst | Out-Null
    Copy-Item -Force (Join-Path $src 'package.json') $dst
    if (Test-Path (Join-Path $src 'lib')) {
        Copy-Item -Recurse -Force (Join-Path $src 'lib') $dst
    } else {
        throw "plugin '$p' has no built lib/ (did the build step run?)."
    }
    # Drop TypeScript build caches so the shipped package holds only runtime files.
    Get-ChildItem -Path $dst -Recurse -Filter '*.tsbuildinfo' -File -ErrorAction SilentlyContinue | Remove-Item -Force
    # The loader imports the package's resolved entry by package name; the client
    # face needs the browser bundle. Resolve the real entry (exports["."] / main)
    # rather than assuming a flat lib/index.js (vibe-mode and mode-ui nest it).
    $manifest = ConvertTo-Hash (Get-Content (Join-Path $dst 'package.json') -Raw | ConvertFrom-Json)
    $entry = Resolve-PluginEntry $dst $manifest
    if (-not $entry -or -not (Test-Path $entry)) {
        throw "plugin '$p': host entry missing (resolved '$entry')"
    }
    if ($clientPlugins -contains $p) {
        if (-not (Test-Path (Join-Path $dst 'lib\client.js'))) { throw "client plugin '$p': lib/client.js missing after build" }
    }
    Write-Host "  + @dsh-plugin/$p"
}

# ── 3) copy the profile overlay + preset + consumer scripts/README ──────────
$presetDst = Join-Path $pkgDir 'agent-presets\standard-rw'
New-Item -ItemType Directory -Force -Path $presetDst | Out-Null
Copy-Item -Force $patchFile (Join-Path $pkgDir 'cordis.patch.yml')
Copy-Item -Force (Join-Path $profileDir 'agent-presets\standard-rw\preset.yml')       $presetDst
Copy-Item -Force (Join-Path $profileDir 'agent-presets\standard-rw\agent.cordis.yml') $presetDst
Copy-Item -Force (Join-Path $pluginRoot 'setup.ps1')  $pkgDir
Copy-Item -Force (Join-Path $pluginRoot 'start.ps1')  $pkgDir
Copy-Item -Force (Join-Path $pluginRoot 'README.md')  $pkgDir
Set-Content -Path (Join-Path $pkgDir 'VERSION') -Value $Version -NoNewline

# ── 4) zip it. Compress-Archive with a single source folder keeps the top-level
#         `dsh-suite-<version>` folder, so unzip yields a self-titled directory.
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$zip = Join-Path $OutputDir "dsh-suite-$Version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $pkgDir -DestinationPath $zip -CompressionLevel Optimal

# clean the staging tree
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }

Write-Host "==> release zip: $zip"

# ── 5) documented (NOT executed) tag + Release commands ──────────────────────
Write-Host ""
Write-Host "Next steps (documented; not run here):"
Write-Host "  git tag v$Version"
Write-Host "  git push origin v$Version"
Write-Host "  gh release create v$Version `"$zip`" --title `"dsh-suite $Version`" --notes `"See plugin/README.md for install/usage.`""
