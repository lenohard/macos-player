# corner

macOS 本地音乐播放器，支持本地文件、百度网盘与 WebDAV。桌面版独立运行，不需要 Corner Web，应用 ID 为 `com.lenohard.corner.desktop`。

## 下载安装

从 [Releases](https://github.com/lenohard/macos-player/releases) 页面下载对应平台的安装包：

- **macOS**: `corner-<version>-mac-<arch>.dmg`
- **Windows**: `corner-<version>-win-x64.exe`（NSIS 安装器）
- **Linux**: `corner-<version>-linux-x64.AppImage` 或 `.deb`

> 正式 macOS Release 使用 Developer ID 签名和 Apple 公证。`dist` 里的本地测试包不等同于正式发布包。

## 更新

应用内置自动更新（electron-updater）：有新版时会提示下载，退出后自动安装。

## Share Hub 网页版

在 [Share Hub → 书与媒体 → Corner Web 音乐](https://mathemac-mini.tailb0587a.ts.net/hub/corner/) 打开。网页端由 Mac mini 上独立的后台应用 **Corner Web**（`com.lenohard.corner.web`）提供，不依赖桌面播放器。它在启动时及每小时索引 `/Volumes/Mote/music`；外置盘离线不会清空索引。桌面与网页的歌单、收藏、AI 检索记录和播放队列各自独立，不会自动同步。

WonderTree 的 LaunchAgent `com.user.corner-web` 启动 `~/opt/corner-web/Corner Web.app`。服务继续使用 `~/Library/Application Support/corner/server-library`，桌面继续使用相邻的 `local-library`；升级不搬迁现有数据。Share Hub 只代理白名单接口，服务端令牌不下发浏览器。更换网页应用包后运行 `launchctl kickstart -k gui/$(id -u)/com.user.corner-web`，无需重启桌面。

## 开发

```bash
npm install
npm run dev      # 开发模式
npm run build     # 只构建桌面到 out/main、out/preload、out/renderer
npm run dist      # 只打包桌面（不上传）
npm run build:web # 只构建网页和后台入口到 out/web
npm run dist:web  # 打包独立后台应用到 dist/web（macOS，不上传）
```

发布新版本：更新 `package.json` 的 `version`，然后 push `v*.*.*` tag，GitHub Actions 会自动打包并发布到 Releases。

## 百度网盘登录配置

开发者需要配置百度开放平台 OAuth 凭据（构建时注入 main bundle）：

| 环境变量 | 必填 |
|----------|------|
| `BAIDU_CLIENT_ID` | 是 |
| `BAIDU_CLIENT_SECRET` | 是 |
| `BAIDU_REDIRECT_URI` | 是（须与百度开放平台注册一致） |
| `BAIDU_SCOPE` | 否（默认 `basic,netdisk`） |

本地开发写在仓库根目录 `.env`（已 gitignore）；CI 打包在 GitHub repo 的 **Settings → Secrets and variables → Actions** 中配置同名 Secrets。

## AI 检索

在侧栏「AI 检索」里选择曲目，查看进行中的任务和最近 100 条已结束的记录。切换页面不会打断检索；应用退出后，尚未完成的任务会在下次启动时标为「已中断」。每次检索的结果单独保存，删除记录不会删除曲目或曲目详情里已有的歌曲资料。

在「设置 → 大模型」中配置 pi-web 地址和默认模型。连接测试会检查模型目录；模型和凭据由 pi-web 服务管理。

### Corner 命令行（CLI）

在桌面版「设置 → 关于」里安装 `corner`。`corner <命令>` 默认管理桌面曲库，必要时启动桌面播放器；`corner --web <命令>` 只连接已运行的 Corner Web 后台服务。两者不回退到另一套库；自动化请按目标库查出新的曲目或歌单 ID，再用该 ID 操作。

```bash
corner search '泡沫' --json                       # 桌面曲库（含已导入的网盘）
corner library update '<已导入的网盘根目录>' --json  # 桌面网盘同步
corner --web playlists --json                      # 网页曲库
```

两边均可管理各自的歌单、收藏和检索任务。播放控制和网盘同步仅支持桌面；网页版在浏览器内播放，本地曲库在后台自动扫描。AI 检索的 `--model` 接受 `服务商:模型 ID`，省略时使用目标端的默认模型。

```bash
corner song-info --prompt "Cesária Évora - Sodade"
corner song-info --get "Sodade"
corner song-info --tasks
corner song-info --result <任务ID>
corner song-info --retry <任务ID>
corner song-info --cancel <任务ID>
corner song-info --delete <任务ID>
```
