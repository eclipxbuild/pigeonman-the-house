import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { manusGameTuning } from './scripts/manus-tuning/vite.mjs'
import { loadEnv, type Plugin, type ViteDevServer } from 'vite'
import { defineConfig } from 'vitest/config'

type AssetLock = { assets?: Record<string, { path?: string }> }

function localRegisteredStorageAssets(): Plugin {
  const root = resolve(process.cwd())
  const manifest = JSON.parse(readFileSync(resolve(root, 'assets.lock.json'), 'utf8')) as AssetLock
  const localByUrl = new Map<string, string>()
  for (const [relativePath, entry] of Object.entries(manifest.assets ?? {})) {
    if (!entry.path?.startsWith('/manus-storage/game/sha256/')) continue
    const filePath = resolve(root, relativePath)
    if (filePath.startsWith(`${root}${sep}`)) localByUrl.set(entry.path, filePath)
  }

  const attachStorageMiddleware = (middlewares: ViteDevServer['middlewares']) => {
    middlewares.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      let pathname: string
      try { pathname = new URL(req.url ?? '/', 'http://vite.local').pathname }
      catch { return next() }
      if (!pathname.startsWith('/manus-storage/')) return next()

      const filePath = localByUrl.get(pathname)
      if (!filePath) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('No registered local asset matches this storage URL.')
        return
      }
      if (!existsSync(filePath)) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Registered local asset is not restored; restart with the package dev command.')
        return
      }

      const extension = extname(filePath).toLowerCase()
      const mime = extension === '.glb' ? 'model/gltf-binary'
        : extension === '.png' ? 'image/png'
          : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
            : 'application/octet-stream'
      res.statusCode = 200
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Length', statSync(filePath).size)
      res.setHeader('Cache-Control', 'no-store')
      if (req.method === 'HEAD') { res.end(); return }
      const stream = createReadStream(filePath)
      stream.on('error', () => {
        if (res.headersSent) res.destroy()
        else { res.statusCode = 500; res.end('Unable to read registered local asset.') }
      })
      stream.pipe(res)
    })
  }

  return {
    name: 'local-registered-storage-assets',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) { attachStorageMiddleware(server.middlewares) },
    configurePreviewServer(server) { attachStorageMiddleware(server.middlewares) },
  }
}

// Relative base keeps production output portable; the Session owns preview HOST/PORT.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', ['HOST', 'PORT'])
  const port = Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
  return {
    base: './',
    plugins: [manusGameTuning(), localRegisteredStorageAssets()],
    server: {
      host: env.HOST ?? '127.0.0.1', port, strictPort: true,
      allowedHosts: ['.manuspre.computer', '.manus.computer', '.manus-asia.computer', '.manuscomputer.ai', '.manusvm.computer', 'localhost', '127.0.0.1'],
    },
    build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4600, sourcemap: false },
    test: { environment: 'node', include: ['tests/**/*.test.{ts,mjs}'] },
  }
})
