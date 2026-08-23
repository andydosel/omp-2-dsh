# dsh-suite — prebuilt plugin bundle

This is a self-contained, prebuilt distribution of the `@dsh-plugin/*` suite for
the DeepSeek Harness web profile. It bundles seven plugins (built `lib/`
included) so a consumer does **not** need the git repo, `pnpm`, or a TypeScript
toolchain to run them.

| Plugin | Package | Client face |
|---|---|---|
| tree-engine | `@dsh-plugin/tree-engine` | — |
| compact-mode | `@dsh-plugin/dsh-compact-mode` | — |
| vibe-mode | `@dsh-plugin/dsh-vibe-mode` | browser bundle (`lib/client.js`) |
| tool-read-write | `@dsh-plugin/dsh-tool-read-write` | — |
| advisor | `@dsh-plugin/dsh-advisor` | — |
| channel-wechat | `@dsh-plugin/dsh-channel-wechat` | — |
| mode-ui | `@dsh-plugin/dsh-mode-ui` | browser bundle (`lib/client.js`) |

## Why a zip, not npm

dsh loads each plugin **by package name** from the profile dir and imports the
built `lib/index.js` (and `lib/client.js` for the two client-faced plugins).
`lib/` is gitignored, so git only carries source; a Release asset is the one way
to ship runnable plugins without a build step. A GitHub Release also needs no
registry scope, no `npm login`, and no publish token — just a zip attached to a
tag.

## Prerequisites

- **dsh** published CLI (`npm i -g @deepseek-ai/dsh`) — or a local dsh monorepo
  build if you use `-DshRoot` in `start.ps1`. `dsh web` auto-initializes the
  `web` profile on first boot.
- **Node ≥ 24** (required by `tool-read-write` and `channel-wechat`).
- **`DEEPSEEK_API_KEY`** environment variable set before boot.

## Install (once)

1. Download `dsh-suite-<version>.zip` from the Release and extract it (anywhere).
2. In the extracted `dsh-suite-<version>/` folder, run:

   ```powershell
   powershell -ExecutionPolicy Bypass -File setup.ps1
   ```

   This copies the seven packages into `~/.dsh/profiles/web/node_modules/@dsh-plugin/`,
   installs the `standard-rw` agent preset into `~/.dsh/.agent-presets/`, stages
   the overlay at `~/.dsh/dsh-suite/cordis.patch.yml`, and verifies every `lib/`.
   It is idempotent — re-running it is safe.

## Daily start

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```

or, with a local monorepo:

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1 -DshRoot C:\Users\you\dsh
```

This just runs `dsh web --patch ~/.dsh/dsh-suite/cordis.patch.yml` — **no build,
no install**. Forward extra args (e.g. `--dump-config`) after the script name.

## Upgrade

Re-download the new release zip, extract, re-run `setup.ps1` once, then boot.
Because `setup.ps1` merges over the existing install, an upgrade overwrites the
changed `lib/` files in place.

## Notes / caveats

- **`channel-wechat` is disabled by default** and mutually exclusive with the
  hermes gateway (same iLink bot account). To enable it, flip `enabled: true` in
  the overlay and stop hermes first. The staged `stateDir` in the shipped
  `cordis.patch.yml` is a machine-specific default and only matters once enabled.
- The overlay (`cordis.patch.yml`) disables `compaction-basic`, `command-compact`
  and `tool-fs`; on the web profile the stock `tool-fs` row is an idempotent
  no-op. See the file comments for the rationale.
- After changing a client-face plugin (`vibe-mode` / `mode-ui`) source you must
  rebuild `lib/client.js`; the browser gets whatever bundle is on disk at boot.
