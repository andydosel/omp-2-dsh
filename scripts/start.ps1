# start.ps1 — daily boot: run `dsh web --patch <staged overlay>` with NO build
# and NO install. This is the whole point of the Release distribution: the
# plugins are prebuilt and already copied into the web profile by setup.ps1, so
# every day is a single boot command.
#
# Default uses the published `dsh` CLI (installed e.g. via `npm i -g
# @deepseek-ai/dsh`). Pass -DshRoot to launch from a local dsh monorepo instead
# (then it runs `pnpm dsh ...`). Remaining args are forwarded to dsh.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File start.ps1
#   powershell -ExecutionPolicy Bypass -File start.ps1 -DshRoot C:\Users\you\dsh
#   powershell -ExecutionPolicy Bypass -File start.ps1 --dump-config
param(
    [string]$DshRoot = '',
    [string]$Patch = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Patch) { $Patch = Join-Path $HOME '.dsh\dsh-suite\cordis.patch.yml' }
if (-not (Test-Path $Patch)) {
    throw "overlay patch not found at '$Patch'. Run setup.ps1 first (it stages the patch here)."
}

if ($DshRoot) {
    if (-not (Test-Path $DshRoot)) { throw "dsh monorepo not found at '$DshRoot'." }
    Push-Location $DshRoot
    try {
        pnpm dsh web --patch $Patch @args
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
} else {
    dsh web --patch $Patch @args
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
