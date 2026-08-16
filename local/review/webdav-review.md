# WebDAV Review: Fix Scope & Recommendations

## Summary

Three issues identified, two of which require code changes (the third is partially done).

| Issue | Status | Effort |
|-------|--------|--------|
| 1. Path-prefix duplication (`/dav/dav`) | Bug — needs fix | Small (2 files, ~10 lines) |
| 2. Edit/disconnect existing connection | Edit = done; disconnect = missing | Small (4 files, ~25 lines) |
| 3. Connected WebDAV UI improvement | Mostly done; missing header context bar | Small (2 files, ~20 lines) |

---

## Issue 1: Base URL path-prefix duplication

### Root Cause — `hrefPath()` in `src/main/webdav.ts`

When user configures `https://server/dav` and PROPFIND returns href `/dav/subfolder/`:

```
hrefPath('/dav/subfolder/')
  → pathname = '/dav/subfolder/'
  → basePath = '/dav'
  → pathname.startsWith('/dav/') → strips prefix → '/subfolder/'  ✓

BUT: hrefPath('/dav')  (server returns current directory)
  → pathname = '/dav'
  → pathname.startsWith('/dav/') → FALSE (no trailing slash)
  → returns '/dav'  ✗  (should return '/')
```

Then `joinPath('/dav')` → `https://server/dav/dav` — the duplication.

### Fix — `src/main/webdav.ts`, `hrefPath()` function (line ~17)

Replace the function body:

```typescript
function hrefPath(href: string): string {
  try {
    const pathname = decodeURIComponent(new URL(href, `${baseUrl()}/`).pathname)
    const prefix = basePath()
    if (prefix === '/') return pathname           // no base path to strip
    if (pathname === prefix) return '/'            // ← ADD: current directory case
    if (pathname.startsWith(`${prefix}/`)) {
      return pathname.slice(prefix.length) || '/'
    }
    return pathname
  } catch { return href }
}
```

**One added line** (`if (pathname === prefix) return '/'`) fixes both the `/dav/dav` duplication and the "fake dav root" problem (current directory href not normalizing to `/`, causing it to survive the `listDirectory` filter and appear as a phantom entry).

### Edge cases

| basePath | href | Before | After |
|----------|------|--------|-------|
| `/` | `/anything` | `/anything` | `/anything` (unchanged) |
| `/dav` | `/dav` | `/dav` ✗ | `/` ✓ |
| `/dav` | `/dav/sub/` | `/sub/` | `/sub/` (unchanged) |
| `/dav` | `/other` | `/other` | `/other` (unchanged) |
| `/dav/music` | `/dav/music` | `/dav/music` ✗ | `/` ✓ |
| `/dav/music` | `/dav/music/songs/` | `/songs/` | `/songs/` (unchanged) |

### Known limitation (not fixable in scope)

WebDAV servers that return hrefs **without** the base-path prefix (e.g. Alist-style mounts where `/dav` is the mount point but hrefs are `/Music/` not `/dav/Music/`) will produce wrong request URLs. This is a server-interop issue and requires either user hint (separate mount-path config) or response-sniffing — out of scope for this fix.

### Test suggestions

```
// hrefPath unit tests (mock load() to return { url: 'https://server/dav' })
assert(hrefPath('https://server/dav/') === '/')
assert(hrefPath('/dav/') === '/')
assert(hrefPath('/dav') === '/')              // THE FIX
assert(hrefPath('/dav/sub/') === '/sub/')
assert(hrefPath('sub/') === '/sub/')          // relative

// With basePath = '/'
assert(hrefPath('/anything') === '/anything')

// Integration: listDirectory root produces no entry with id==='//'
```

---

## Issue 2: Edit & Disconnect an Already Configured Connection

### Edit — ALREADY IMPLEMENTED ✅

The codebase already has full edit support:

- `webdavEditing` state (App.tsx:149)
- "修改 WebDAV" button in header (App.tsx:795-806) — pre-fills form with current URL + username
- Form shows "修改 WebDAV 连接" title + password hint (App.tsx:1164-1165)
- Cancel button in edit mode (App.tsx:1205-1211)
- CSS classes `.webdav-edit-state`, `.webdav-form-actions` exist in index.css

### Password-preservation bug when editing

When editing, password is sent as `''` (empty). `saveConfig` in `webdav.ts` overwrites it:

```typescript
// webdav.ts:saveConfig — line ~38
config = { url: next.url.trim(), username: next.username, password: next.password }
// password: '' → overwrites the saved password with empty string
```

**Fix** — `src/main/webdav.ts`, `saveConfig()` method (~line 38):

```typescript
saveConfig(next: WebDAVConfig): WebDAVStatus {
  // ...validation...
  const existing = load()
  config = {
    url: next.url.trim(),
    username: next.username,
    password: next.password || existing?.password || ''
  }
  // ...encrypt + write...
}
```

One-line change. Renderer already sends empty password on edit; backend now preserves it.

### Disconnect — MISSING

No `deleteConfig()`/`webdavDisconnect` exists. Needs:

**`src/main/webdav.ts`** — add method to `WebDAVService`:

```typescript
deleteConfig(): WebDAVStatus {
  config = null
  try { unlinkSync(configPath()) } catch { /* already gone */ }
  return this.getStatus()
}
```

**`src/shared/ipc.ts`** — add channel + API method:

```typescript
// IPC_CHANNELS (after webdavListRoots)
webdavDisconnect: 'webdav:disconnect',

// IPCApi (after webdavListRoots)
webdavDisconnect(): Promise<WebDAVStatus>
```

**`src/preload/index.ts`** — add bridge:

```typescript
webdavDisconnect: (): Promise<WebDAVStatus> =>
  ipcRenderer.invoke(IPC_CHANNELS.webdavDisconnect),
```

**`src/main/index.ts`** — register handler:

```typescript
ipcMain.handle(IPC_CHANNELS.webdavDisconnect, () => webdavService.deleteConfig())
```

**`src/renderer/src/App.tsx`** — add handler + button in header:

```typescript
// Handler (near logoutBaidu, ~line 378)
async function disconnectWebdav(): Promise<void> {
  setIsWebdavBusy(true)
  setError(null)
  try {
    setWebdavStatus(await window.api.webdavDisconnect())
    setWebdavEntries([])
    setWebdavPath('/')
    setWebdavRoots([])
    setWebdavEditing(false)
    setLibraryTracks([])
    setLibraryTotal(0)
  } catch (reason) {
    setError(messageFrom(reason, '断开 WebDAV 失败'))
  } finally {
    setIsWebdavBusy(false)
  }
}
```

Button in header — adjacent to "修改 WebDAV" (after line 806):

```tsx
{isQuark && webdavStatus?.connected && !webdavEditing && (
  <button
    className="quiet-button"
    onClick={() => void disconnectWebdav()}
    disabled={isWebdavBusy}
  >
    断开连接
  </button>
)}
```

### Edge cases

- **Disconnect while sync in progress**: `setIsWebdavBusy` already guards the UI; server requests will fail naturally after config is cleared. Consider a check `if (syncProgress?.phase === 'scanning')` + confirmation prompt as a future enhancement.
- **Edit → save fails**: `saveWebdavConfig` catches errors and calls `setError`; `webdavEditing` stays `true` so user can retry. Correct behavior.
- **Disconnect with imported roots in DB**: Disconnect only clears the credential file. Imported tracks remain in SQLite with `source_id='quark'`. They become unplayable (stream requests fail) but stay in playlists. This mirrors Baidu's `logoutBaidu` behavior — intentional.
- **Unlink failure**: `unlinkSync` wrapped in try/catch handles race condition where file was already deleted.

### Test suggestions

```
// deleteConfig
- Call deleteConfig → getStatus() returns { configured: false, connected: false, ... }
- Credential file is removed from disk
- Calling request() after deleteConfig throws "请先配置 WebDAV"

// saveConfig with empty password
- saveConfig({ url: 'https://server/dav', username: 'u', password: '' })
  → config.password preserves previously saved password

// Full flow
- saveConfig with password 'p1' → verify testConnection succeeds
- edit: saveConfig with password '' → verify testConnection still succeeds (password preserved)
- disconnect → verify configured: false
- saveConfig with new password 'p2' → verify works
```

---

## Issue 3: Connected WebDAV UI Improvements

### Already implemented ✅

- Browse / 音乐库 tabs (identical structure to Baidu)
- Directory browser with back/refresh navigation
- Import with playlist naming
- Roots panel with per-root resync
- Paginated index search
- Edit mode with cancel

### Missing — connected header info bar

When connected, the header only shows `WebDAV 网盘` + "修改 WebDAV" button. The connected URL/username aren't visible anywhere. Add a small status strip below the header.

**`src/renderer/src/App.tsx`** — insert after `{isQuark && webdavStatus?.connected && !webdavEditing && (` header block (~after line 808), before `<section className="library-content">`:

```tsx
{isQuark && webdavStatus?.connected && !webdavEditing && (
  <div className="cloud-status-bar">
    <span className="cloud-url" title={webdavStatus.url}>{webdavStatus.url}</span>
    {webdavStatus.username && <span className="cloud-user">{webdavStatus.username}</span>}
  </div>
)}
```

**`src/renderer/src/index.css`** — add rule (near `.webdav-form` at line 621):

```css
.cloud-status-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  font-size: 12px;
  color: var(--text-secondary, #888);
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
  margin-bottom: 8px;
}
.cloud-url {
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cloud-user::before {
  content: '·';
  margin-right: 12px;
}
```

### Additional UI polish (optional, minimal effort)

1. **Disconnect confirmation**: Wrap `disconnectWebdav()` in a `window.confirm('断开后已导入的曲目仍保留在音乐库中，但无法播放。确定断开？')` — one line, no new UI.

2. **Source sidebar badge**: Add the server hostname to the sidebar status text:
   ```typescript
   // sourceStatus() — replace the 'quark' branch (~line 438)
   if (source.type === 'quark') {
     if (!webdavStatus) return '检查中'
     if (webdavStatus.connected) {
       try { return new URL(webdavStatus.url).hostname } catch { return '已连接' }
     }
     return '未连接'
   }
   ```
   Shows `dav.example.com` instead of `已连接` — gives immediate context about which server.

3. **Empty-state for no audio files in directory**: Currently directories with no audio files show nothing. Add:
   ```tsx
   {visibleWebdavEntries.length === 0 && (
     <div className="directory-empty">此目录下没有音频文件。</div>
   )}
   ```

---

## File Change Summary

| File | Changes | Lines |
|------|---------|-------|
| `src/main/webdav.ts` | Fix `hrefPath()` + password-preservation in `saveConfig()` + add `deleteConfig()` | ~10 added/changed |
| `src/shared/ipc.ts` | Add `webdavDisconnect` channel + `IPCApi` method | 2 |
| `src/preload/index.ts` | Add `webdavDisconnect` bridge | 2 |
| `src/main/index.ts` | Register `webdavDisconnect` handler | 1 |
| `src/renderer/src/App.tsx` | Add `disconnectWebdav` handler + disconnect button + status bar + hostname badge | ~25 |
| `src/renderer/src/index.css` | `.cloud-status-bar` + `.cloud-url` + `.cloud-user` rules | ~15 |

**Total: ~55 lines across 6 files.** No schema changes, no new dependencies, no IPC DTO changes beyond adding one channel.

---

## Verification

```bash
npm run typecheck   # must pass
npm run build       # must pass
```

Manual test matrix:
1. Configure WebDAV → verify browse/import/play work (no `/dav/dav` in network tab)
2. Edit connection → change username only → save → verify password preserved
3. Edit connection → change password → save → verify new password works
4. Disconnect → verify form reappears, sidebar shows "未连接"
5. Disconnect → reconnect with same URL → verify existing imported roots are still in 音乐库 tab
6. Server with path-prefix URL (e.g. `/dav`) → navigate into subdirectories → verify correct paths in network requests
