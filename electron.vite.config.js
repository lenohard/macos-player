const { resolve } = require('path')
const { defineConfig, loadEnv } = require('electron-vite')

const defineVars = ['BAIDU_CLIENT_ID', 'BAIDU_CLIENT_SECRET', 'BAIDU_REDIRECT_URI', 'BAIDU_SCOPE']

module.exports = defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const define = {}
  for (const key of defineVars) {
    const value = process.env[key] ?? fileEnv[key] ?? ''
    define[`process.env.${key}`] = JSON.stringify(value)
  }

  return {
    main: {
      build: {
        outDir: 'out/main',
        rollupOptions: {
          external: ['better-sqlite3']
        }
      },
      define
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
  }
})
