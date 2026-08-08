const { resolve } = require('path')
const { defineConfig, loadEnv } = require('electron-vite')

const defineVars = ['BAIDU_CLIENT_ID', 'BAIDU_CLIENT_SECRET', 'BAIDU_REDIRECT_URI', 'BAIDU_SCOPE']

module.exports = defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '')
  const define = {}
  for (const key of defineVars) {
    // 注意：process.env 里可能残留空字符串，?? 不会回退；用 || 确保空值回退到 .env 文件
    const value = process.env[key]?.trim() || fileEnv[key]?.trim() || ''
    define[`process.env.${key}`] = JSON.stringify(value)
  }

  return {
    main: {
      build: {
        outDir: 'out/main'
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
