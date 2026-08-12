# AGENTS.md — macos-player

Guidance for AI agents and contributors working on this repository.

## What this is

Electron **macOS** music player for **local files** and **cloud libraries** (Baidu Netdisk first; Quark planned as **generic WebDAV**, not a Quark-specific OAuth app). UI product name: **corner** (`app.setName('corner')`); repo: [lenohard/macos-player](https://github.com/lenohard/macos-player).

## Commands

```bash
cd /Users/senaca/projects/macos-player
npm install          # install dependencies; SQLite uses Electron's built-in node:sqlite
npm run dev          # electron-vite dev + Electron window
npm run typecheck    # main + preload + renderer TS projects
npm run build        # output to out/
npm run icon         # generate build/icon.icns from the corner Logo
npm run preview      # run packaged build
npm run dist         # mac dmg + zip → dist/ (no upload)
npm run release      # build + publish GitHub Release (set GH_TOKEN)
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
- `ai.ts` — `AiService`: LLM provider config + model list. Non-secret config in `userData/ai-config.json`; API key encrypted via `safeStorage` → `userData/credentials/ai-key.bin` (same as Baidu token). Models endpoint `{baseUrl}/models`; `message` protocol uses `x-api-key` + `anthropic-version`, others use `Bearer`.

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

Main reads static `process.env.BAIDU_*` in `baidu.ts`. Values come from the shell **or** a gitignored repo-root `.env` (see `.gitignore`); `electron.vite.config.js` uses `loadEnv` + Vite `define` to bake them into the main bundle at **dev/build** time (personal packaging—do not commit `.env`).

| Variable | Required |
|----------|----------|
| `BAIDU_CLIENT_ID` | yes |
| `BAIDU_CLIENT_SECRET` | yes |
| `BAIDU_REDIRECT_URI` | yes (must match Baidu open platform) |
| `BAIDU_SCOPE` | optional, default `basic,netdisk` |

After changing `.env`, restart `npm run dev` or run `npm run build` before `npm run preview`. Vite config filename must be `electron.vite.config.js` (not `electron-vite.config.js`) so the main build configuration is loaded.

APIs (main only): authorize `openapi.baidu.com/oauth/2.0/authorize`; token `/oauth/2.0/token`; list `pan.baidu.com/rest/2.0/xpan/file`; download `d.pcs.baidu.com/rest/2.0/pcs/file` (User-Agent `pan.baidu.com`).

## IPC surface

All channels live in `IPC_CHANNELS` and `IPCApi` in `src/shared/ipc.ts`. Sync progress events use `SYNC_PROGRESS_CHANNEL` (`library:syncProgress`), not invoke. Track details use `track:getDetail` and are loaded on demand; `TrackDetail` carries path, size, modified time, MD5, and the provider remote ID.

When adding features: extend **shared types first**, then main handler, preload, renderer.

## Renderer notes

- Alias: `@shared` → `src/shared` (see `electron.vite.config.js`).
- Static assets: `src/renderer/public/`; use **relative** `./…` URLs in production (`file://`).
- Branding: `src/renderer/public/corner-logo.png` is the canonical app Logo; use `./corner-logo.png` for the renderer favicon and sidebar mark. Runtime/package identity is `corner` (`app.setName('corner')` plus the package name). Run `npm run icon` to generate the macOS bundle icon at `build/icon.icns`; full packaging/signing remains M6.
- Large libraries (~10k tracks): use `listTracksPage` (UI page size 100), not loading full lists into React state.

## Build / native deps

- SQLite uses Electron's built-in synchronous `node:sqlite` (`DatabaseSync`); there is no native SQLite npm addon or `electron-rebuild` step.
- After Electron major upgrades, verify `node:sqlite` availability and run `npm run typecheck && npm run build`.

## Roadmap (high level)

| Milestone | Status |
|-----------|--------|
| M0 skeleton, typed IPC | done |
| M1 local playback, queue | done |
| M2 Baidu + SQLite import/sync/playlists/shuffle | in progress (code landed; needs real-account validation at scale) |
| M3 generic WebDAV (Quark) | not started |
| M4 search, favorites, recents | not started |
| M5 macOS polish (media keys, menus) | not started |
| M6 packaging / signing | electron-builder + GitHub auto-update wired; unsigned local `npm run dist`; CI release on `v*.*.*` tag |

Detailed checklist and decisions: `local/task/progress.md` (may be gitignored by user global `local/` rule; still useful locally).

### AI 设置页：脱敏 key 不进 state（血泪教训）

- **问题**：页面加载时把 `apiKeyMasked`（如 `sk-••••abcd`）写入受控 state → `dirty` 判定字段变更 → 600ms debounce 触发 `saveNow()` → 主进程把脱敏值当真密钥加密保存，覆盖 safeStorage 中的原始 key → UI 闪现旧样式。
- **根因**：任何写入受控 input state 的非空值都会被 debounce 当作用户输入触发保存。
- **正确做法**：用 `keyDirty` ref（或 state）标记「用户已编辑」；初始化时 input 保持空；仅在 `keyDirty.current === true` 且 `apiKey.trim() !== ''` 时才发送 apiKey 到主进程。脱敏值可作 placeholder 或只读展示，绝不能进入受控 state。
- **判断是否需要保存**：`keyDirty.current ? apiKey.trim() : ''`。

## Conventions for agents

1. **Small diffs** — match existing style; DB access only in main via `LibraryService`.
2. **No secrets in repo** — no `.env` with credentials; document env vars only.
3. **No reference-project OAuth secrets** — env-only configuration.
4. Verify with `npm run typecheck` and `npm run build` after substantive changes.
5. Quark = **WebDAV provider abstraction**; do not implement Aliyun/Quark proprietary APIs unless explicitly requested.
6. Prefer extending SQLite + IPC over in-memory maps for library state.

## Lessons learned (playback, packaging, agents)

### Playback queue vs playlist (UI)

- **播放列表（queue）** = 当前可持久化的播放队列（SQLite `queue_*`）；侧边栏「播放列表」视图编辑的是它。
- **歌单（playlist）** = 库里的命名列表；进入歌单应 **只加载曲目供浏览**，不要用 `replaceQueueAndPlay`。
- 用户显式操作才改队列并开播：**全部播放**（整单替换 + 自动播放）、**随机选择20首**（随机最多 20 首 + 自动播放）；单首点击仍走 **temporary track**，播完回到队列。
- **持久化陷阱**：启动时 `tracks` 初始为 `[]`；若在 hydration 完成或队列仍空时 `queueSave`，会把库里已有队列 **清空**。只在 `queueHydrated && tracks.length > 0` 时防抖写入。
- 恢复队列时过滤已删曲目并重映射 `currentIndex` / `playOrder`（main `loadPlaybackQueue`）。

### Packaging & hot update (M6)

- **不必照搬** [deepchat](~/projects/deepchat) 的 channel、releaseAssembly、updater-metadata-consumer；corner 用 **最小链路**：`electron-builder` + `electron-updater` + GitHub Releases。
- **可对齐 deepchat 的主进程模式**：`autoDownload = false`、`autoInstallOnAppQuit = true`、`compare-versions` 过滤 `<=` 当前版、`quitAndInstall(false, true)`、releaseNotes/releaseDate 格式化。
- **产物**：mac 同时打 **dmg**（给人装）和 **zip**（给 auto-update）；确认 `dist/latest-mac.yml` 存在后再发 Release。
- **更新仅打包版**：`app.isPackaged` 为 false 时 UI 显示「开发模式不检查更新」，`checkForUpdates` 直接返回 snapshot，不要误报 error。
- **`UpdateSnapshot`**：对 renderer 始终带 `appVersion`、`enabled`；内部 patch 用不含这两字段的 state，避免重复字段不一致。
- **`package.json`**：`repository` 字段、`version` 与 git tag（如 `v0.0.2`）一致；发布前确认构建机有 **BAIDU_***（Vite `define` 打进 main bundle，不是运行时读 `.env`）。
- **BAIDU define 注入坑**：注入逻辑必须用 `process.env[key]?.trim() || fileEnv[key]?.trim() || ''`——若环境变量是**空字符串**，`??` 不回退 .env 文件，产物会注入空值（现象：播放正常但 UI 显示「请先配置 Client ID」）。
- **百度「请先配置」误判**：若 `IPC_CHANNELS.baiduGetStatus` 未在主进程 `ipcMain.handle` 注册，renderer 的 `baiduGetStatus()` 会 reject，`.catch()` 会把状态设成 `configured: false`，文案与真未配置相同；播放仍可用（token 在 safeStorage）。新增/改 IPC 时按 `src/shared/ipc.ts` → main → preload → renderer 全链路核对。
- **本地**：`npm run dist`（不上传）；**发布**：`npm run release` 或 push `v*.*.*` tag 触发 `.github/workflows/release-mac.yml`（`GH_TOKEN` = `GITHUB_TOKEN`）。
- **签名/公证（已配好）**：Developer ID 签名 + notarize 已打通。本地 keychain 有 `Developer ID Application: denghui wang (285P3M6846)`（p12 在 `~/.agents/skills/apple-cli-build/extra/corner-devid.p12`，密码 `corner2026`）；`electron-builder.yml` `mac.notarize: true`；CI 用 secrets：`CSC_LINK`（p12 base64）+ `CSC_KEY_PASSWORD` + `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`（见 apple-cli-build skill）。本地打包不设 API key env 时会跳过公证（正常）。
- **electron-builder 默认把 GitHub Release 打成 draft**：`npm run release`（`--publish always`）成功后 Release 仍是 draft，而 electron-updater 不会提供 draft 更新 → 每次发版后需 `env -u GH_TOKEN gh release edit <tag> --draft=false`（GH_TOKEN 环境变量会遮蔽 gh，见全局 memory）。

### Agent / workflow pitfalls

- 多个 pi/Cursor 会话 **共用同一 repo cwd** 时，主任务 commit 后 **陈旧 subagent 仍可能改工作树** 或留下未跟踪文件；大改后尽快 typecheck + commit，或 subagent 用 **git worktree**。
- 本机 **`GH_TOKEN` 环境变量会遮蔽 gh/keyring**；`gh` / `git push` 用 `env -u GH_TOKEN …`（见全局 agent memory）。
- Vite 主配置文件名必须是 **`electron.vite.config.js`**（不是连字符变体），否则 main 外链/环境注入不生效。
- 验证习惯：`npm run typecheck` → `npm run build` → 打包改动时加 `npm run dist`；IPC 改动顺序：**`src/shared/ipc.ts` → main → preload → renderer**。

## Remote

```bash
git remote -v   # origin → git@github.com:lenohard/macos-player.git
```

Push only when the user asks; do not force-push `main`.


## Reference
~/projects/deepchat
When you have some issuse or have to make some decidisons You can refere to this repo whichi I think is a good and mature electron app.
