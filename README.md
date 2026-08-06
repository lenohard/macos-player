# corner

macOS 本地音乐播放器，支持本地文件与百度网盘云音乐库。

## 下载安装

从 [Releases](https://github.com/lenohard/macos-player/releases) 页面下载最新的 `corner-<version>-mac-<arch>.dmg` 安装。

> 当前版本为**未签名构建**（无 Apple Developer ID），首次打开会被 Gatekeeper 拦截。请用以下任一方式打开：
>
> - **右键** → 打开（比双击多一步确认，之后可正常使用）；或
> - 终端执行 `xattr -cr /Applications/corner.app` 清除隔离标记后双击打开

## 更新

应用内置自动更新（electron-updater）：有新版时会提示下载，退出后自动安装。

## 开发

```bash
npm install
npm run dev      # 开发模式
npm run build    # 构建
npm run dist     # 本地打包 dmg + zip（不上传）
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
