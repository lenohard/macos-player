import { app } from 'electron'
import { mkdirSync } from 'fs'
import { resolve } from 'path'

export function getDataDir(): string {
  const dataDir = resolve(process.env.CORNER_DATA_DIR?.trim() || app.getPath('userData'))
  mkdirSync(dataDir, { recursive: true })
  return dataDir
}
