/**
 * Move a SeatGeek listings JSON downloaded from the browser into place.
 *
 * Chrome's "Copy response" silently fails on large payloads (the listings
 * response is ~2.4 MB), and its sanitized HAR export strips bodies. Downloading
 * the response from the page's own context sidesteps both, so this picks up the
 * downloaded file and validates it.
 *
 *   node scripts/seatgeek-ingest.ts [path]
 *
 * With no argument it takes the newest seatgeek*.json in ~/Downloads.
 */
import { readdirSync, statSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const OUT = 'captures/raw/seatgeek.json'
const HAR = 'captures/raw/seatgeek.har'

function newestDownload(): string | null {
  const dir = path.join(homedir(), 'Downloads')
  if (!existsSync(dir)) return null
  const hits = readdirSync(dir)
    .filter((f) => /^seatgeek.*\.json$/i.test(f))
    .map((f) => {
      const p = path.join(dir, f)
      return { p, mtime: statSync(p).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  return hits[0]?.p ?? null
}

const src = process.argv[2] ?? newestDownload()
if (!src) {
  console.error('No seatgeek*.json found in ~/Downloads, and no path given.')
  console.error('Run the console snippet from the README, then re-run this.')
  process.exit(1)
}
if (!existsSync(src)) {
  console.error(`${src} does not exist`)
  process.exit(1)
}

const text = readFileSync(src, 'utf8')
if (!text.trim()) {
  console.error(`${src} is empty (0 bytes) — the download did not write any content.`)
  process.exit(1)
}

let parsed: unknown
try {
  parsed = JSON.parse(text)
} catch (e) {
  console.error(`${src} is not valid JSON: ${(e as Error).message}`)
  if (/captcha|blocked|access denied/i.test(text.slice(0, 2000))) {
    console.error('It looks like a block page rather than the listings response.')
  }
  process.exit(1)
}

// Shape check before committing it, so a wrong file fails here and not later.
const { findListingsArray } = await import('../capture/sources/seatgeek.ts')
const rows = findListingsArray(parsed)
if (!rows?.length) {
  console.error(
    `${src} parsed as JSON but contains no listing-shaped rows ` +
      '(rows need a section-ish and a price-ish field).',
  )
  console.error('Make sure it is the event_listings_v2 response, not the events metadata call.')
  process.exit(1)
}

// A stale .har would take precedence over the .json in the module's load order.
if (existsSync(HAR)) {
  rmSync(HAR)
  console.log(`removed stale ${HAR}`)
}
copyFileSync(src, OUT)
console.log(`${OUT} — ${(text.length / 1e6).toFixed(2)} MB, ${rows.length} listing rows`)
console.log('\nnow run:  npm run capture -- seatgeek')
