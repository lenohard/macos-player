import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AiService } from './ai'
import { startCliServer } from './cli-server'
import { openLibraryDatabase } from './library-db'
import { LibraryService } from './library'
import { scanLocalLibrary } from './local-library-scan'
import { SongInfoService } from './song-info'

app.setName('Corner Web')

// Use the existing web library and discovery files, not the desktop library.
const legacyProfile = join(app.getPath('appData'), 'corner')
process.env.CORNER_ENDPOINT_DIR ||= legacyProfile
process.env.CORNER_DATA_DIR ||= join(legacyProfile, 'server-library')
mkdirSync(process.env.CORNER_ENDPOINT_DIR, { recursive: true })
const runtime = join(process.env.CORNER_ENDPOINT_DIR, 'service-runtime')
mkdirSync(runtime, { recursive: true })
app.setPath('userData', runtime)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    const library = new LibraryService(openLibraryDatabase())
    const ai = new AiService()
    app.once('before-quit', startCliServer({
      library,
      songInfo: new SongInfoService(library, () => ai.getConfig()),
      endpointDir: process.env.CORNER_ENDPOINT_DIR || legacyProfile
    }))

    let scanning = false
    const runScan = (): void => {
      if (scanning) return
      scanning = true
      void scanLocalLibrary(library, process.env.CORNER_MUSIC_DIR || '/Volumes/Mote/music')
        .then(result => console.log(`[Local library] indexed ${result.tracksUpserted} files; ${result.issues.length} issues`))
        .catch(error => console.error('[Local library] scan failed:', error))
        .finally(() => { scanning = false })
    }
    runScan()
    const scanTimer = setInterval(runScan, 60 * 60 * 1000)
    scanTimer.unref()
  }).catch(error => {
    console.error('[Corner Web] startup failed:', error)
    app.exit(1)
  })
}
