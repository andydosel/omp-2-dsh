# setup.ps1 — install a prebuilt dsh-suite release zip into the user's dsh home.
# Runs ONCE after extracting dsh-suite-<version>/; idempotent (safe to re-run).
#
# What it does:
#   1. Copies each @dsh-plugin/<name> package into
#      ~/.dsh/profiles/web/node_modules/@dsh-plugin/<name> so the Cordis loader
#      and client-modules resolve every patch row BY PACKAGE NAME (including the
#      built lib/client.js bundle for the client-faced plugins).
#   2. Stages cordis.patch.yml at ~/.dsh/dsh-suite/cordis.patch.yml so start.ps1
#      can reference a stable --patch path. That patch declares the `standard-rw`
#      agent preset itself (a `@deepseek-ai/dsh-agent-preset` row), so there is
#      no preset directory to install: 0.2.0-rc.2 reads none.
#   3. Verifies each plugin's resolved host entry (and lib/client.js where needed).
#
# Usage (from anywhere; the script lives in the extracted zip root):
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -DshHome C:\Users\you\.dsh
param(
    [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot   # the extracted dsh-suite-<version> dir

if (-not $DshHome) { $DshHome = Join-Path $HOME '.dsh' }
if (-not (Test-Path (Join-Path $src 'cordis.patch.yml'))) {
    throw "cordis.patch.yml not found next to setup.ps1 — unzip the whole dsh-suite-<version> dir first."
}

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

$profileDir = Join-Path $DshHome 'profiles\web'
$pluginsDir = Join-Path $profileDir 'node_modules\@dsh-plugin'
$suiteState = Join-Path $DshHome 'dsh-suite'

New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null
New-Item -ItemType Directory -Force -Path $suiteState | Out-Null

# These are the INSTALLED directory names = the package name minus the
# `@dsh-plugin/` scope, i.e. exactly the `@dsh-plugin/<name>/` folders inside the
# zip. The Cordis loader imports each row BY PACKAGE NAME from the profile's
# node_modules, so the folder name must match the package name (note:
# `tree-engine`, whose repo dir is `dsh-tree-engine`, ships as `tree-engine/`).
$plugins       = @(
    'dsh-worker-spawn', 'tree-engine', 'dsh-compact-mode',
    'dsh-tool-read-write', 'dsh-advisor', 'dsh-channel-wechat',
    'dsh-mode-ui', 'dsh-review-gate', 'dsh-question-board',
    'dsh-task-board', 'dsh-rules', 'dsh-peers', 'dsh-org',
    'dsh-orchestrator'
)
$clientPlugins = @('dsh-mode-ui', 'dsh-org', 'dsh-task-board', 'dsh-question-board')

# ── 1) copy each plugin package into the web profile node_modules ───────────
Write-Host "==> install plugins into $pluginsDir"
foreach ($p in $plugins) {
    $s = Join-Path $src ("@dsh-plugin\" + $p)
    if (-not (Test-Path $s)) { throw "zip is missing plugin '$p' (expected at '$s')." }
    $d = Join-Path $pluginsDir $p
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    # merge, idempotent: overwrite/add files; re-running yields the same tree.
    Copy-Item -Recurse -Force -Path (Join-Path $s '*') -Destination $d
    $manifest = ConvertTo-Hash (Get-Content (Join-Path $d 'package.json') -Raw | ConvertFrom-Json)
    $entry = Resolve-PluginEntry $d $manifest
    if (-not $entry -or -not (Test-Path $entry)) {
        throw "copy of '$p' lacks its host entry (resolved '$entry')."
    }
    if ($clientPlugins -contains $p) {
        if (-not (Test-Path (Join-Path $d 'lib\client.js'))) { throw "copy of '$p' lacks lib/client.js (client face)." }
    }
    Write-Host "  - @dsh-plugin/$p"
}

# ── 2) stage the overlay patch for start.ps1 ────────────────────────────────
Write-Host "==> stage overlay patch for start.ps1"
Copy-Item -Force (Join-Path $src 'cordis.patch.yml') (Join-Path $suiteState 'cordis.patch.yml')

Write-Host ""
Write-Host "dsh-suite installed into $DshHome"
Write-Host "  Daily boot:  powershell -ExecutionPolicy Bypass -File start.ps1"
Write-Host "  Or manual:   dsh web --patch `"$(Join-Path $suiteState 'cordis.patch.yml')`""
Write-Host "  Requires:    DEEPSEEK_API_KEY env var; Node >=24; dsh published CLI (or a local dsh monorepo build)."
