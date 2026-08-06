const { resolve } = require('path')
const { defineConfig } = require('electron-vite')

module.exports = defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    build: { outDir: 'out/preload' }
  },
  renderer: {
    root: 'src/renderer',
    build: { outDir: 'out/renderer' },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  }
})
