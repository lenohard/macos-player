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
npm run dist         # 当前平台打包（mac: dmg+zip / win: nsis / linux: AppImage+deb）→ dist/（不上传）
npm run release      # build + publish GitHub Release（set GH_TOKEN）
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

## 音乐库 (music library) 概念

- 一个「音乐库」= `library_roots` 表里的一行 = 一个**已导入的网盘根目录**（import root），以 `root_path` 区分（如 `/音乐`）。字段：`source_id`（baidu/quark）、`root_path`、`playlist_id`（导入时自动关联的歌单）、`last_sync_at/status`。示例见 `index.ts` 的 `baiduListRoots`。
- 「更新某个音乐库」= 对那个 `rootPath` 重跑 resync（BFS 扫描该目录，增删改曲目 + 软删未见 + 更新关联歌单），返回 `BaiduImportResult { rootPath, playlistId, scanned, added, updated, removed, addedTracks, updatedTracks, removedTracks }`。
- CLI：`corner libraries`（列出音乐库） / `corner library update <rootPath>`（更新指定库）。`cli-server.ts` 通过 `startCliServer(library, getMainWindow, resyncLibrary)` 注入的 `resyncLibrary(rootPath)` 回调（在 `index.ts` 接线，按 rootPath 匹配 baidu/quark 后调 `resyncBaiduDirectory`/`resyncWebDAVDirectory`）。

## CLI REST API

Implemented in `src/main/cli-server.ts`; client is `scripts/corner-cli.mjs` (installed as `corner`). Server binds `127.0.0.1` on a random port written to `userData/cli-port`; an auth token is written to `userData/cli-token` (mode 0600) and must be sent as `Authorization: Bearer <token>` on every request except `GET /health`.

Endpoints (all JSON):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | liveness (no auth) |
| GET | `/status` | playback state (`playback` = `PlaybackState`) |
| GET | `/events` | SSE stream of `{type:'playback',state}` |
| GET | `/sources` | source list |
| GET | `/libraries` | list imported music libraries (library_roots) |
| POST | `/libraries/update` | re-sync a library: body `{rootPath}` → `{rootPath,playlistId,scanned,added,updated,removed}` |
| GET/POST | `/playlists` | list / create (`{name}`) |
| GET/PATCH/DELETE | `/playlists/:id` | get / rename / delete |
| GET/POST | `/playlists/:id/tracks` | list / add (`{trackId}` or `{trackIds}`) |
| DELETE | `/playlists/:id/tracks/:trackId` | remove track |
| GET | `/search?q=&limit=` | search tracks |
| POST | `/play` | `{playlistId\|trackId\|query}` |
| POST | `/toggle-play` `/next` `/prev` `/shuffle` `/repeat` | transport |
| POST | `/volume` | `{volume:0..1}` |
| POST | `/seek` | `{positionSec}` absolute or `{offsetSec}` relative |
| GET | `/favorites` | list favorites |
| GET/PUT/DELETE | `/favorites/:trackId` | check / add / remove favorite |
| GET | `/history?limit=` | recently played |

Transport commands (`/play`, `/toggle-play`, `/volume`, `/seek`, …) are sent to the renderer via `playback:remoteCommand` and **awaited for ack** (`playback:ackCommand`) with a 3s timeout; `ok` reflects whether the renderer confirmed the command (not whether playback itself completed). `PlaybackState` is pushed renderer→main on `playback:pushState` and includes `volume`, `positionSec`, `durationSec`.

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
- **显隐完整链路**：仅返回 `apiKeyMasked` 或切换 `<input type>` 不能查看已保存密钥。renderer 应默认展示脱敏 placeholder；用户点击眼睛时才经显式 IPC 让 main 从 `safeStorage` 解密并返回真实值。真实密钥不可在页面初始化时主动下发。
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
- **⚠️ 版本号同步（血泪教训）**：打 tag 前确认 `package.json#version` 已更新为对应版本号。若 `package.json` 版本号滞后，electron-builder 会构建旧版本并尝试发到旧 release，导致新 release 无 assets → auto-update 404。**打 tag 前必检**：`node -e "console.log(require('./package.json').version)"` 与 tag 后缀一致。
- **BAIDU define 注入坑**：注入逻辑必须用 `process.env[key]?.trim() || fileEnv[key]?.trim() || ''`——若环境变量是**空字符串**，`??` 不回退 .env 文件，产物会注入空值（现象：播放正常但 UI 显示「请先配置 Client ID」）。
- **百度「请先配置」误判**：若 `IPC_CHANNELS.baiduGetStatus` 未在主进程 `ipcMain.handle` 注册，renderer 的 `baiduGetStatus()` 会 reject，`.catch()` 会把状态设成 `configured: false`，文案与真未配置相同；播放仍可用（token 在 safeStorage）。新增/改 IPC 时按 `src/shared/ipc.ts` → main → preload → renderer 全链路核对。
- **本地**：`npm run dist`（当前平台，不上传）；**发布**：`npm run release` 或 push `v*.*.*` tag 触发 `.github/workflows/release.yml`（`GH_TOKEN` = `GITHUB_TOKEN`，三平台 matrix：macOS + Windows + Linux）。
- **签名/公证（已配好）**：Developer ID 签名 + notarize 已打通。本地 keychain 有 `Developer ID Application: denghui wang (285P3M6846)`（p12 在 `~/.agents/skills/apple-cli-build/extra/corner-devid.p12`，密码 `corner2026`）；`electron-builder.yml` `mac.notarize: true`；CI 用 secrets：`CSC_LINK`（p12 base64）+ `CSC_KEY_PASSWORD` + `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`（见 apple-cli-build skill）。本地打包不设 API key env 时会跳过公证（正常）。
- **electron-builder 默认把 GitHub Release 打成 draft**：`npm run release`（`--publish always`）成功后 Release 仍是 draft，而 electron-updater 不会提供 draft 更新 → 每次发版后需 `env -u GH_TOKEN gh release edit <tag> --draft=false`（GH_TOKEN 环境变量会遮蔽 gh，见全局 memory）。
- **⚠️ 已有 release 会拦截重发（同版本回移 tag 时）**：若该 tag 的 release 已存在且为**非 draft**，electron-builder 会报 `existing type not compatible with publishing type (existingType=release publishingType=draft)` 并**跳过全部资产上传**，workflow 显示 success 但资产仍是旧的。修复流程：`env -u GH_TOKEN gh release delete <tag> --yes`（保留 tag）→ `git push origin :refs/tags/<tag>` 再 `git push origin <tag>`（重推制造 push 事件触发 CI）→ 等新 run 完成后 `gh release edit <tag> --draft=false`。判断产物是否更新：看资产 `updatedAt` 是否为新构建时间，别只看 workflow conclusion。

### Agent / workflow pitfalls

- 多个 pi/Cursor 会话 **共用同一 repo cwd** 时，主任务 commit 后 **陈旧 subagent 仍可能改工作树** 或留下未跟踪文件；大改后尽快 typecheck + commit，或 subagent 用 **git worktree**。
- **发布版本必须在任何 dist 之前锁定**：先同步 `package.json`、`package-lock.json` 的版本并检查 package root 版本，再运行 `typecheck`/`build`/`dist`；不要在 electron-builder 运行期间修改版本。提交和 tag 后缀必须与版本一致。
- 推荐发布顺序：完成代码 → 更新并校验版本 → `typecheck`/`build` → commit → 创建 tag → 本地 dist 仅作 sanity check → push tag 交给 CI 正式签名、公证和发布。不要把本地“已签名但未公证”的产物手动上传为正式 Release。
- Tag workflow 成功不代表 Release 已正式可见：发布后检查 `isDraft`/`isPrerelease`，并核对每个平台的安装包、`latest*.yml`、版本、文件名、size 和 sha512；electron-builder 若留下 draft，需要显式设为非 draft。
- electron-builder 若在 macOS 报 `Electron.app/Contents/MacOS/Electron` 缺失，先用 `unzip -t` 验证对应 `~/Library/Caches/electron/electron-*.zip`；若归档损坏，只删除该缓存和本次不完整的 `dist/<arch>` 后重试一次，勿无限重试或把未完成 app 的 codesign 失败误判为证书问题。
- GitHub Actions 当前会提示 `actions/checkout@v4`/`setup-node@v4` 被强制使用 Node.js 24；不影响本次发布，但后续应升级 action 版本或 workflow 运行时以消除弃用警告。
- 本机 **`GH_TOKEN` 环境变量会遮蔽 gh/keyring**；`gh` / `git push` 用 `env -u GH_TOKEN …`（见全局 agent memory）。
- Vite 主配置文件名必须是 **`electron.vite.config.js`**（不是连字符变体），否则 main 外链/环境注入不生效。
- 验证习惯：`npm run typecheck` → `npm run build` → 打包改动时加 `npm run dist`；IPC 改动顺序：**`src/shared/ipc.ts` → main → preload → renderer**。

### 音乐库 = library_roots 一行（挂接歌单）

- **音乐库** = 一个已导入的云端根目录（`library_roots` 一行：`source_id`/`root_path`/`playlist_id`）。更新 = 对该 `rootPath` 重新同步。
- **⚠️ 悬空 playlist_id 导致 FK 失败（血泪教训）**：用户删除歌单时若不检查，`library_roots.playlist_id` 会指向一个已被删除的 `playlists` 行；后续 resync 的 `replacePlaylistTracks` 执行 `INSERT INTO playlist_tracks` 时，因 `playlist_tracks.playlist_id → playlists(id)` 外键而抛 `FOREIGN KEY constraint failed`（现象：`corner library update "<root>"` exit=1，约十几秒扫描后崩溃）。
- **正确做法（已实现）**：① resync 前先 `library.ensurePlaylistForRoot(sourceId, rootPath)` —— 若关联歌单不存在则重建并修复 `library_roots.playlist_id`（自愈悬空引用，旧库也能恢复）；② `deletePlaylist` 若目标歌单被 `library_roots` 引用则直接 throw（「是音乐库的关联歌单，不能删除」），从源头杜绝悬空引用。
- **`library_roots.playlist_id` 是无外键的裸列**：它不 `REFERENCES playlists(id)`，所以删除歌单不会自动 CASCADE，也检测不到悬空。重命名/删除歌单时务必走 guard。

## 本地 AI 服务（pi-web，2026-08-28 决策）

- **方案 A**：corner 不内嵌 pi SDK（`@earendil-works/pi-coding-agent`），改为调用本地 **pi-web** 服务（https://github.com/agegr/pi-web ，Next.js，corner 默认 `http://127.0.0.1:8964`，env `PI_WEB_URL` 可覆盖）。原因：用户多个 app 都需要同款 model/agent 能力，集中一处管 key + 扩展。
- **无退化**：pi-web 不可达直接报错（用户明确要求），不做降级路径、不做端口自动发现。
- 本机常驻（2026-08-28 定）：**launchd** `~/Library/LaunchAgents/com.pi-web.plist`（Label `com.pi-web`，RunAtLoad+KeepAlive），稳定安装 `~/opt/pi-web`，plist 用 node 绝对路径直启 `bin/pi-web.js`（**launchd 禁用 npx**：冷启动全量解析依赖 + 无 PATH，详见 doc-center skill `pi-web-http-api.md`）。`0.0.0.0:8964` **无鉴权**（Tailscale `100.109.27.51:8964`）；日志 `~/Library/Logs/pi-web.{log,err.log}`；升级 = `cd ~/opt/pi-web && npm i @agegr/pi-web@新 && launchctl kickstart -k gui/$(id -u)/com.pi-web`。
- 调用模式：`POST /api/agent/new` body `{cwd, type:"prompt", message, provider, modelId, thinkingLevel:"off"}`（**不传 toolNames**——它只收内置工具名，扩展工具如 web_search 由服务端自动加载）→ 立刻订阅 `GET /api/agent/[id]/events`（SSE 不重放，晚订阅=丢消息），以 `message_end(stopReason=endTurn)` 为主、`prompt_done` 兜底；SSE 为空时轮询 `GET /api/agent/:id` 解析 `sessionFile` JSONL 恢复（`recoverAnswer()`）；`prompt_error` 抛错。
- key/模型配置由 pi-web 侧统一（共享 `~/.pi/agent` 的 auth.json / models.json），corner 不存任何 key。
- **⚠️ SSE `text_delta` 禁止 `trim()`（v0.0.25 血泪教训）**：流式分片常在英文单词边界切开，`asText(delta)` 会删除每个片段首尾空格，产生随机单词粘连；JSON 仍可解析，因此会伪装成模型输出质量问题。delta 必须原样拼接；`text_end` / `message_end` / `prompt_done` 的完整文本可在更长时作为权威覆盖。验证这类链路必须走实际 SSE，不能轮询 `sessionFile` 原始 assistant text（后者绕过了采集层，本次测试因此误判过）。
- ~~待删~~（2026-08-28 已完成）：HTTP client 化后 dynamic import / vite external / loader 校验已全部移除，pi 依赖已卸载。

## Remote

```bash
git remote -v   # origin → git@github.com:lenohard/macos-player.git
```

Push only when the user asks; do not force-push `main`.


### pi-web integration (song-info / agent)

- **模型 ID 格式**：pi-web 用 `provider:modelId`（如 `opencode-go:qwen3.8-max`），**不是** `provider/modelId`。`PiWebAgentClient.ask` 必须用 `:` 切分，默认 provider `opencode-go`。
- **模型 scope 校验**：pi-web 启动时检查 enabled scope，**未在 scope 列表的模型直接 reject**（`Model is not available in the enabled scope`）。改默认模型前先 `curl http://100.109.27.51:8964/api/models` 看 `modelList[*].id` 和 `scopeWarnings`。
- **SSE 事件不重放**：`/api/agent/<id>/events` 只发订阅后产生的事件；订阅晚于完成/断流则拿不到任何 event。`recoverAnswer` 轮询 `/api/agent/<id>` → 读 `sessionFile` JSONL 拿最后一段 assistant 文本。
- **pi-web state 响应结构**：`/api/agent/<id>` 返回 `{state: {isStreaming, isPromptRunning, sessionFile}, ...}`，**state 字段在 `body.state`，不在 `body.data`**（create 响应是 `body.data`）。`recoverAnswer` 必须 `asRecord(body?.data) ?? asRecord(body?.state) ?? body`，否则 `sessionFile` 永远 undefined → 静默返回空串 → 表现「pi-web agent 未返回歌曲信息」。
- **mac-remote-control PWA 硬编码模型**：`static/app.js` 顶部有 `SONG_INFO_MODEL` 常量，改 corner 默认模型时必须同步改 PWA，否则 PWA 发的还是旧模型。
- **SSE 流式转发链路（screenshot_server.py）**：`corner_request` 用 `urlopen` + `response.read()` 一次性读 JSON，**不能直接透传 SSE**。`/api/music/song-info?stream=1` 需走专用路径：`send_response(200) + text/event-stream 头` 后用 `response.read(4096)` 循环 + `self.wfile.flush()` 逐块转发，最后写 `event: error` SSE 帧处理异常。

## Reference
~/projects/deepchat
When you have some issuse or have to make some decidisons You can refere to this repo whichi I think is a good and mature electron app.
