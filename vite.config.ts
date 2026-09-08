import { readFile } from 'node:fs/promises'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

/**
 * Serves /captures/*.json off disk during dev.
 *
 * Capture output lives at the project root (not in public/) because it's
 * generated data, not a static asset. This is also the seam where a future
 * POST /api/capture would live: it would call the same capture() functions the
 * script calls and write the same file. Deliberately nothing more than a file
 * read today — the parsers stay out of the UI's import graph.
 */
function serveCaptures(): Plugin {
  return {
    name: 'serve-captures',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/captures/')) return next()
        const rel = req.url.split('?')[0].replace(/^\/+/, '')
        if (rel.includes('..')) return next()
        try {
          const body = await readFile(rel)
          res.setHeader('content-type', 'application/json')
          res.setHeader('cache-control', 'no-store')
          res.end(body)
        } catch {
          res.statusCode = 404
          res.end('{}')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveCaptures()],
  server: {
    port: 5173,
    watch: {
      // Capture scripts and their raw payloads live in the project root but are
      // not part of the app's module graph — watching them reloads the page for
      // no reason every time a capture writes a file.
      ignored: ['**/captures/**', '**/capture/**', '**/manifest/**', '**/scripts/**'],
    },
  },
})
