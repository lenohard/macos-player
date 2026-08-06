# AGENTS.md — macos-player

Guidance for AI agents and contributors working on this repository.

## What this is

Electron **macOS** music player for **local files** and **cloud libraries** (Baidu Netdisk first; Quark planned as **generic WebDAV**, not a Quark-specific OAuth app). UI product name: **corner** (`app.setName('corner')`); repo: [lenohard/macos-player](https://github.com/lenohard/macos-player).

## Commands

```bash
cd /Users/senaca/projects/macos-player
npm install          # runs electron-rebuild for better-sqlite3
npm run dev          # electron-vite dev + Electron window
npm run typecheck    # main + preload + renderer TS projects
npm run build        # output to out/
npm run icon         # generate build/icon.icns from the corner Logo
npm run preview      # run packaged build
```

Do not commit `node_modules/`, `out/`, or `*.tsbuildinfo`.

## Architecture

| Layer | Path | Responsibility |
|-------|------|----------------|
| Main | `src/main/` | Window, IPC handlers, SQLite, Baidu OAuth/API, `app-media://` protocol |
| Preload | `src/preload/` | `contextBridge` → `window.api` (typed `IPCApi`) |
| Renderer | `src/renderer/` | React UI, queue/shuffle/playlists (no Node) |
| Shared | `src/shared/ipc.ts` | **Single source of truth** for channel names and DTOs |

**Security (do not weaken):**

- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- OAuth secrets and tokens **only in main**; read OAuth from `process.env`, never from committed files.
- Baidu refresh/access token: encrypted via `safeStorage` → `userData/credentials/baidu-token.bin`.
- Playback URLs are resolved at runtime; **do not persist** signed download URLs in SQLite.

## Key main-process modules

- `index.ts` — IPC wiring, `app-media` handler, local file dialog.
- `library-db.ts` — SQLite schema v1, migrations, WAL; file: `userData/library.sqlite`.
- `library.ts` — `LibraryService`: paginated tracks, playlists, `resolveMedia(id)`.
- `baidu.ts` — OAuth popup, directory listing, streaming proxy (Range for seek).
- `baidu-sync.ts` — BFS recursive scan, bulk upsert, soft-delete unseen tracks, playlist link per import root.

## Data model (SQLite)

- `tracks`: `source_id`, `remote_id` (Baidu `fs_id`), `path`, metadata, `is_deleted`, `last_seen_sync`. Unique `(source_id, path)`; partial unique on `(source_id, remote_id)`.
- `library_roots`: imported Baidu folder paths + optional `playlist_id`.
- `playlists` / `playlist_tracks`: user playlists and ordering.
- **Import** = index into DB + playlist, **not** downloading audio to disk unless a future offline feature is added explicitly.

## Media playback

- Tracks expose `playbackUrl`: `app-media://{trackId}/audio`.
- `protocol.handle('app-media')` → `LibraryService.resolveMedia` → local `net.fetch(file URL)` or `BaiduService.stream(path, request)` with Range forwarding.

Register privileged scheme **before** `app.whenReady()` (see `index.ts`).

## Baidu OAuth (developer setup)

Set in the **same shell** that runs `npm run dev`:

| Variable | Required |
|----------|----------|
| `BAIDU_CLIENT_ID` | yes |
| `BAIDU_CLIENT_SECRET` | yes |
| `BAIDU_REDIRECT_URI` | yes (must match Baidu open platform) |
| `BAIDU_SCOPE` | optional, default `basic,netdisk` |

APIs (main only): authorize `openapi.baidu.com/oauth/2.0/authorize`; token `/oauth/2.0/token`; list `pan.baidu.com/rest/2.0/xpan/file`; download `d.pcs.baidu.com/rest/2.0/pcs/file` (User-Agent `pan.baidu.com`).

## IPC surface

All channels live in `IPC_CHANNELS` and `IPCApi` in `src/shared/ipc.ts`. Sync progress events use `SYNC_PROGRESS_CHANNEL` (`library:syncProgress`), not invoke.

When adding features: extend **shared types first**, then main handler, preload, renderer.

## Renderer notes

- Alias: `@shared` → `src/shared` (see `electron.vite.config.js`).
- Static assets: `src/renderer/public/`; use **relative** `./…` URLs in production (`file://`).
- Branding: `src/renderer/public/corner-logo.png` is the canonical app Logo; use `./corner-logo.png` for the renderer favicon and sidebar mark. Runtime/package identity is `corner` (`app.setName('corner')` plus the package name). Run `npm run icon` to generate the macOS bundle icon at `build/icon.icns`; full packaging/signing remains M6.
- Large libraries (~10k tracks): use `listTracksPage` (UI page size 100), not loading full lists into React state.

## Build / native deps

- `better-sqlite3` is **external** in main Rollup config; requires `postinstall` `electron-rebuild`.
- After Electron major upgrades, verify rebuild and run `npm run typecheck && npm run build`.

## Roadmap (high level)

| Milestone | Status |
|-----------|--------|
| M0 skeleton, typed IPC | done |
| M1 local playback, queue | done |
| M2 Baidu + SQLite import/sync/playlists/shuffle | in progress (code landed; needs real-account validation at scale) |
| M3 generic WebDAV (Quark) | not started |
| M4 search, favorites, recents | not started |
| M5 macOS polish (media keys, menus) | not started |
| M6 packaging / signing | icon resource configured; packaging/signing not started |

Detailed checklist and decisions: `local/task/progress.md` (may be gitignored by user global `local/` rule; still useful locally).

## Conventions for agents

1. **Small diffs** — match existing style; DB access only in main via `LibraryService`.
2. **No secrets in repo** — no `.env` with credentials; document env vars only.
3. **No reference-project OAuth secrets** — env-only configuration.
4. Verify with `npm run typecheck` and `npm run build` after substantive changes.
5. Quark = **WebDAV provider abstraction**; do not implement Aliyun/Quark proprietary APIs unless explicitly requested.
6. Prefer extending SQLite + IPC over in-memory maps for library state.

## Remote

```bash
git remote -v   # origin → git@github.com:lenohard/macos-player.git
```

Push only when the user asks; do not force-push `main`.
