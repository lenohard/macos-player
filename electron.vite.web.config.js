const { resolve } = require('node:path')
const { defineConfig } = require('electron-vite')

module.exports = defineConfig({
  main: {
    build: {
      outDir: 'out/web/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/web-service.ts')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    publicDir: 'web-public',
    build: {
      outDir: 'out/web/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/web.html')
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  }
})
