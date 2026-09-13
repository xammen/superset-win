# Superset Windows (patched, unofficial)

Unofficial Windows builds of [superset-sh/superset](https://github.com/superset-sh/superset) — The Terminal for Coding Agents — with stability patches applied on top of upstream.

## Download

Go to [Releases](../../releases) and grab `Superset-<version>-x64.exe`.

## Why this fork

Upstream Superset does not officially support Windows. [Ashesh3/superset-windows](https://github.com/Ashesh3/superset-windows) maintains a patch set (documented in `PATCHES-UPSTREAM.md`, patches 0-33) that makes the app run on Windows. This fork carries that patch set **plus additional fixes** for bugs that remained after those patches:

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 34 | 1-5s UI freeze when switching workspaces/tabs/opening settings | `@parcel/watcher` performs its initial recursive directory scan synchronously on the calling thread; called from the Electron main process this stalls the whole app (measured: two ~5.3s main-thread stalls, ~99.9% of CPU profiler samples inside the native `subscribe()`) | The native watcher runs inside a shared worker thread on Windows (`packages/workspace-fs/src/parcel-worker-proxy.ts`), with graceful fallback to in-thread subscribe |
| 35 | Console window flash (Windows Terminal) on every workspace switch | The parcel native backend probes for a watchman install by spawning `cmd.exe /c watchman get-sockname` from C++ on every subscribe — invisible to any JS-level `child_process` patch, and Windows Terminal's default-terminal handoff ignores `windowsHide` | The `windows` backend is pinned explicitly, skipping the probe entirely (it was falling back to that backend anyway after the probe failed) |
| 36 | `Failed to fetch` across the whole UI (workspace creation, lists, terminals) | The Windows renderer runs on the custom `superset-app://app` origin, but the local host-service CORS allowlist only accepted dev origins (`localhost:5173`) | `superset-app://app` added to the host-service `allowedOrigins` |
| 37 | pty-daemon crash-restart loop (10s), ghost app instances, more `Failed to fetch` | The desktop bundle's banner deletes `ELECTRON_RUN_AS_NODE` from `process.env`; the daemon supervisor then spawns `Superset.exe pty-daemon.js` without it, so the packaged executable boots the full app (which exits instantly on the single-instance lock, or worse, boots ghost instances) | `ELECTRON_RUN_AS_NODE: "1"` is forced in the daemon spawn env (`DaemonSupervisor.ts`) |
| 38 | Installer scripts (e.g. `codex` self-update) fail inside terminals with "supports Windows only" | The terminal env allowlist did not pass standard Windows system variables (`OS`, `USERNAME`, `PSModulePath`, ...) | 18 standard non-sensitive Windows variables added to the allowlist |
| 39 | Residual console flashes from auxiliary processes | The `windowsHide` monkey-patch ran after modules had captured `util.promisify(childProcess.execFile)` references at load time (bundler module-order semantics) | The patch auto-installs on import and is imported as the first statement of every bundled entry point |
| 40 | Crash at startup: `NODE_MODULE_VERSION 147 vs 145` | `better-sqlite3` was packaged with the Node binary instead of the Electron one when no Visual Studio Build Tools are present | The official Electron-ABI prebuild is substituted during the build (also handled in CI) |

## Maintenance strategy

The patched source is committed directly to this repository (reproducible builds, no AI patch application at release time). When upstream releases a new version:

```bash
git remote add upstream https://github.com/superset-sh/superset.git
git fetch upstream --tags
git merge upstream/desktop-vX.Y.Z   # resolve conflicts in the patched files
git push
```

Then trigger a build (Actions → "Build Windows installer" → Run, or push a `desktop-v*` tag).

## Building locally

Requirements: Windows 10/11 x64, [Bun](https://bun.sh) 1.3.14, Git.

```bash
bun install
cd apps/desktop
bun run generate:icons
bun run compile:app
bun run copy:native-modules
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --win --publish never --config electron-builder.ts
# Installer: apps/desktop/release/Superset-<version>-x64.exe
```

Note: if `electron-rebuild` fails (no VS Build Tools), the `better-sqlite3` binary will be the Node-ABI one and the app will crash at startup — the CI workflow substitutes the official Electron prebuild automatically.

## License

Upstream Superset is licensed under Elastic License 2.0 (ELv2). This repository contains modified upstream source; the same license applies.
