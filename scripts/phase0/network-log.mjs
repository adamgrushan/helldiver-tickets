// Phase 0: open the Ticketmaster event page headed, log every network request.
// Goal: find the files backing the seat map (venue geometry + per-seat availability).
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const EVENT_URL = process.argv[2]
const OUT_DIR = 'manifest/_netlog'
mkdirSync(OUT_DIR, { recursive: true })

const requests = []
const interesting = []

// Anything that smells like map geometry, seat manifest, or inventory/availability.
const INTERESTING = /maps|geometry|placeDetail|manifest|ismds|facets|avail|seat|section|svg|inventory|quantit/i

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] })
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
})
const page = await ctx.newPage()

page.on('request', (r) => {
  requests.push({ method: r.method(), url: r.url(), resourceType: r.resourceType() })
})

page.on('response', async (res) => {
  const url = res.url()
  if (!INTERESTING.test(url)) return
  const ct = res.headers()['content-type'] || ''
  const rec = { url, status: res.status(), contentType: ct }
  if (/json|svg|xml|javascript/i.test(ct)) {
    try {
      const body = await res.body()
      rec.bytes = body.length
      // Save any sizable structured response for offline inspection.
      if (body.length > 200) {
        const safe = url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
        const ext = /svg/i.test(ct) ? 'svg' : /json/i.test(ct) ? 'json' : 'txt'
        writeFileSync(`${OUT_DIR}/${safe}.${ext}`, body)
        rec.savedAs = `${safe}.${ext}`
      }
    } catch (e) { rec.bodyError = String(e.message) }
  }
  interesting.push(rec)
  console.log(`[${res.status()}] ${rec.bytes ?? '-'}B ${ct.split(';')[0]}  ${url.slice(0, 160)}`)
})

console.log('Navigating...')
try {
  await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
} catch (e) { console.log('goto warn:', e.message) }

// Let the seat map lazily load; nudge the page so map tiles/geometry fetch.
await page.waitForTimeout(12000)
try { await page.mouse.move(700, 500); await page.mouse.wheel(0, 300) } catch {}
await page.waitForTimeout(8000)

writeFileSync('manifest/_netlog/_all-requests.json', JSON.stringify(requests, null, 2))
writeFileSync('manifest/_netlog/_interesting.json', JSON.stringify(interesting, null, 2))
console.log(`\n=== ${requests.length} total requests, ${interesting.length} interesting ===`)
console.log('TITLE:', await page.title())
console.log('URL:', page.url())
await browser.close()
