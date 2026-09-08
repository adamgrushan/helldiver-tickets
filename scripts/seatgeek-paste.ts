/**
 * Write a HAR from the clipboard to captures/raw/seatgeek.har, and say
 * immediately whether it is usable.
 *
 * Chrome's Network panel has moved its HAR export between versions, and the
 * save-dialog route has produced 0-byte files. "Copy all as HAR" -> clipboard
 * sidesteps both, and this gives feedback without running a whole capture.
 *
 *   node scripts/seatgeek-paste.ts
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'

const OUT = 'captures/raw/seatgeek.har'

let text: string
try {
  text = execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
} catch (e) {
  console.error(`could not read the clipboard: ${(e as Error).message}`)
  process.exit(1)
}

if (!text.trim()) {
  console.error('clipboard is empty — copy the HAR first (see below), then re-run')
  process.exit(1)
}

let har: { log?: { entries?: Array<{ request?: { url?: string }; response?: { content?: { text?: string; mimeType?: string } } }> } }
try {
  har = JSON.parse(text)
} catch (e) {
  console.error(`clipboard is not valid JSON (${(e as Error).message}).`)
  console.error('Make sure you used Copy > "Copy all as HAR", not "Copy as cURL" or a single request.')
  process.exit(1)
}

const entries = har.log?.entries ?? []
if (!entries.length) {
  console.error('that HAR has 0 entries — the request list was empty when you copied it.')
  console.error('Tick "Preserve log", reload the page with DevTools open, then copy again.')
  process.exit(1)
}

const withBody = entries.filter((e) => e.response?.content?.text)
const jsonBodies = withBody.filter((e) => /json/i.test(e.response?.content?.mimeType ?? ''))

mkdirSync('captures/raw', { recursive: true })
writeFileSync(OUT, text)

console.log(`wrote ${OUT} — ${(text.length / 1e6).toFixed(1)} MB`)
console.log(`  ${entries.length} entries, ${withBody.length} with a response body, ${jsonBodies.length} JSON`)

if (!withBody.length) {
  console.log('\nNo response bodies present. A HAR without bodies cannot be parsed —')
  console.log('use "Copy all as HAR" (which includes content), not a headers-only export.')
  process.exit(1)
}

console.log('\nlargest JSON responses:')
for (const e of jsonBodies
  .map((e) => ({ url: e.request?.url ?? '?', n: (e.response!.content!.text ?? '').length }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 6)) {
  console.log(`  ${String(e.n).padStart(9)}b  ${e.url.slice(0, 110)}`)
}
console.log('\nnow run:  npm run capture -- seatgeek')
