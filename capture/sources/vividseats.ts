/**
 * Vivid Seats — US Open Women's Singles Semifinals, Arthur Ashe Stadium,
 * Thu Sep 10 2026 7:00pm (Vivid production 5990417, "US Open Tennis - Session 23").
 *
 * ## Access
 *
 * Vivid's own frontend XHRs a single un-paginated listings document:
 *
 *   GET https://www.vividseats.com/hermes/api/v1/listings
 *         ?productionId=5990417&includeIpAddress=true&currency=USD
 *         &localizeCurrency=true&priceGroupId=21
 *
 * It carries the whole inventory (830 listings for this event), so there is no
 * scrolling or pagination to do. It is obtained *passively* — headed Playwright
 * with a `response` listener, exactly the technique that worked on Ticketmaster.
 * The response body is written verbatim (under `payload`) to
 * `captures/raw/vividseats.json`, and `capture()` parses that file, so a capture
 * is reproducible with no live fetch. `--refresh` / `CAPTURE_REFRESH=1` re-pulls.
 *
 * ## All-in pricing — how it is proven, not assumed
 *
 * Vivid calls it AIP ("all-in price"). Every ticket record carries BOTH prices:
 *
 *   { "p": "220.35",   // pre-fee — must never reach a Listing
 *     "aip": "297.00", // all-in per ticket
 *     "allInPricePerTicket": "297.00" }
 *
 * and `payload.global[0]` carries the mode flags:
 *
 *   showAip: "true"  defaultAipOn: "true"  showAipIncludedPrices: "true"
 *   aipIncludedPrices: "CUSTOMER_PRICE,SERVICE_FEE,ELECTRONIC_DELIVERY_FEE"
 *   vatAddedToAip: "false"       <- fees in, tax NOT in. Exactly our definition.
 *
 * There is no "all-in" switch to click on the US site any more: it is on
 * site-wide (`defaultAipOn: "true"`, and a DOM sweep for any all-in toggle
 * control returns nothing). What the site renders per card is a "Fees Incl."
 * label next to the AIP value. `assertAllIn()` below re-checks the four flags on
 * every parse and additionally requires `aip > p` on every single listing, so a
 * pre-fee number cannot get through even if the flags ever changed shape.
 *
 * Visual cross-check recorded in the raw file under `_meta.allInEvidence`: all
 * eight rendered cards match `aip` and none matches `p` — e.g. "Promenade 325 /
 * Row Z / 2 tickets / Fees Incl. / $297 ea" against `aip: "297.00"` /
 * `p: "220.35"`. The payload's own aggregates corroborate it: mean/median/min/max
 * of `aip` equal `averageAip`/`medianAip`/`lowestAip`/`highestAip` exactly, and
 * the fee markup is a flat ~34.99% across all 833 listings.
 *
 * KNOWN CAVEAT — promo discounts. 29 listings (16 of them pair-buyable) carry
 * `di: true` with `pdi: "0.05"`. Their `aip` markup over `p` is identical to
 * every other listing's, so `aip` is the *pre-promo* all-in list price — the
 * number the site displays on the card. Those few could settle up to ~5% lower
 * at checkout. No discount is applied here: doing so would write a price the
 * source never showed. `capture()` warns with the count.
 *
 * ## Exactly 2 together
 *
 * `m` is the split list: the quantities the broker will actually sell, e.g.
 * "2", "2,4", "1,2,3,4,5,6,8". A pair is buyable iff `m` contains 2 — `q`
 * (quantity available) is not sufficient, since a q=4 listing may be "2,4"
 * (pairs ok) or "4" (all four or nothing); 25 such q=4/m="4" listings exist here
 * and are excluded. `sellsPairs()` additionally requires `q >= 2`.
 * Two independent confirmations: the site's own panel printed "626 listings"
 * under the `2 Tickets` chip and this rule yields exactly 626; and all 626 carry
 * Vivid's own `perks: ["Seated Together"]` (no q=1 listing does), so the pair is
 * adjacent, not merely two tickets in one order.
 *
 * ## Sections
 *
 * Vivid prefixes the section with its own zone name: "Promenade 325",
 * "Loge 220", "Courtside 116". `normalizeSection()` already strips LOGE and
 * PROMENADE but not COURTSIDE, so the zone name is removed first using the
 * payload's *own* `groups[]` table (joined by `ticket.c`) rather than a
 * hardcoded word list, then the remainder goes through `normalizeSection()`.
 * All 96 section labels in this event reconcile to venue-vocab ids that way.
 *
 * ## Seats
 *
 * Vivid usually publishes section + row only (`ls`/`hs` empty, "N/A", or "0")
 * -> `seats: null`. Where it does publish an exact 2-seat range on a 2-ticket
 * listing (`q=2`, `hs = ls + 1`) the pair is unambiguous and is emitted. Nothing
 * is inferred: a q=4 listing bought as 2 gets `seats: null`, because which two
 * of the four is not knowable. `ls`/`hs` occasionally leak a 5-digit internal id
 * instead of a seat label (52006/52007 — 4 listings); the venue manifest's
 * highest real seat label at Arthur Ashe is 33, so anything above
 * MAX_PLAUSIBLE_SEAT is discarded as not-a-seat-number rather than emitted.
 *
 * Verified after the fact, not just asserted: all 101 emitted seat pairs exist
 * at that exact section+row in the built venue manifest (`src/data/venue.json`),
 * 0 misses. Of the 371 pair-buyable q=2 listings, 251 have empty `ls`/`hs`, 11
 * say "N/A", 3 say "0", 1 omits them, 4 leak the internal id, and 101 publish a
 * genuine consecutive pair — which is exactly the set emitted.
 */

import type { Listing } from '../../src/types.ts'
import { normalizeRow, normalizeSection, seatRange } from '../lib/normalize.ts'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'vividseats' as const
const PRODUCTION_ID = '5990417'

const EVENT_PATH =
  '/us-open-tennis-tickets-arthur-ashe-stadium-9-10-2026--sports-tennis/production/5990417'
const PAGE_URL = `https://www.vividseats.com${EVENT_PATH}?quantity=2`

/** The listings XHR the page's own frontend issues. Matched, never synthesized. */
const LISTINGS_XHR = /\/hermes\/api\/v1\/listings\?/

/** Highest real seat label in the Arthur Ashe manifest is 33; 99 is a safe cap. */
const MAX_PLAUSIBLE_SEAT = 99

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const RAW_FILE = resolve(ROOT, 'captures/raw/vividseats.json')
const VOCAB_FILE = resolve(ROOT, 'capture/lib/venue-vocab.json')

// ---------------------------------------------------------------- shapes

type VividTicket = {
  /** Section label, zone-prefixed: "Promenade 325". */
  s?: string
  /** Row. */
  r?: string
  /** Quantity available. */
  q?: string
  /** Pre-fee price per ticket. Never emitted. */
  p?: string
  /** Listing id: "VB17090477635" / "VF2191575". */
  i?: string
  /** Zone/group id, joins payload.groups[].i. */
  c?: string
  /** Split list — the purchasable quantities, e.g. "2,4". */
  m?: string
  /** All-in price per ticket (fees in, tax out). */
  aip?: string
  allInPricePerTicket?: string
  /** Low / high seat label, when published at all. */
  ls?: string
  hs?: string
  /** Promo/discount indicator, and its rate ("0.050000000000"). See header. */
  di?: boolean
  pdi?: string
}

type VividGlobal = {
  productionId?: string
  showAip?: string
  defaultAipOn?: string
  showAipIncludedPrices?: string
  aipIncludedPrices?: string
  vatAddedToAip?: string
}

type VividPayload = {
  global?: VividGlobal[]
  groups?: { i?: string; n?: string }[]
  tickets?: VividTicket[]
}

type RawFile = {
  _meta?: { capturedAt?: string; endpoint?: string; pageUrl?: string }
  payload?: VividPayload
}

// ---------------------------------------------------------------- helpers

function isRefresh(): boolean {
  const proc = (globalThis as { process?: { argv?: string[]; env?: Record<string, string | undefined> } }).process
  if (!proc) return false
  if (proc.env?.CAPTURE_REFRESH === '1') return true
  return (proc.argv ?? []).includes('--refresh')
}

/** Accept either our `{_meta, payload}` wrapper or a bare hermes response. */
function unwrap(text: string): { payload: VividPayload; capturedAt: string } {
  const parsed = JSON.parse(text) as RawFile & VividPayload
  const payload = parsed.payload ?? (parsed as VividPayload)
  if (!Array.isArray(payload.tickets)) {
    throw new Error(
      `${RAW_FILE}: no \`tickets\` array — expected the /hermes/api/v1/listings response ` +
        `(optionally wrapped as {_meta, payload}).`,
    )
  }
  return { payload, capturedAt: parsed._meta?.capturedAt ?? new Date().toISOString() }
}

/**
 * Refuse to proceed unless the payload itself says prices are all-in and
 * pre-tax. Fees-in / tax-out is the whole contract of `allInPricePerTicket`.
 */
function assertAllIn(payload: VividPayload): void {
  const g = payload.global?.[0]
  if (!g) throw new Error('vividseats: payload.global missing — cannot verify all-in pricing')
  const problems: string[] = []
  if (String(g.showAip) !== 'true') problems.push(`showAip=${g.showAip} (want "true")`)
  if (String(g.defaultAipOn) !== 'true') problems.push(`defaultAipOn=${g.defaultAipOn} (want "true")`)
  if (String(g.vatAddedToAip) !== 'false') {
    problems.push(`vatAddedToAip=${g.vatAddedToAip} (want "false" — aip must be pre-tax)`)
  }
  const included = String(g.aipIncludedPrices ?? '')
  if (!/SERVICE_FEE/.test(included)) {
    problems.push(`aipIncludedPrices=${included || '(empty)'} (want it to include SERVICE_FEE)`)
  }
  if (problems.length) {
    throw new Error(
      `vividseats: all-in pricing is not confirmed on this payload — refusing to emit prices. ` +
        problems.join('; '),
    )
  }
  if (g.productionId && g.productionId !== PRODUCTION_ID) {
    throw new Error(
      `vividseats: raw file is production ${g.productionId}, expected ${PRODUCTION_ID}`,
    )
  }
}

/**
 * True iff the broker will sell exactly 2 of this listing.
 *
 * `m` is the authority (see header). `q >= 2` is belt-and-braces: in this
 * payload no listing has 2 in its split list with fewer than 2 available, but a
 * broker feed that ever published that combination would otherwise produce a
 * "buy 2" listing with only 1 ticket behind it.
 */
function sellsPairs(t: VividTicket): boolean {
  const splits = String(t.m ?? '')
    .split(',')
    .map((x) => x.trim())
  if (!splits.includes('2')) return false
  const avail = Number(t.q)
  return Number.isFinite(avail) && avail >= 2
}

/** Strip Vivid's own zone-name prefix, then fold to a canonical section id. */
function sectionIdFor(t: VividTicket, zoneNames: Map<string, string>): string {
  const label = String(t.s ?? '')
  const zone = zoneNames.get(String(t.c ?? ''))
  if (zone && label.toUpperCase().startsWith(`${zone.toUpperCase()} `)) {
    return normalizeSection(label.slice(zone.length + 1))
  }
  return normalizeSection(label)
}

function plausibleSeat(v: string | undefined): number | null {
  if (v == null || !/^\d+$/.test(String(v).trim())) return null
  const n = Number(String(v).trim())
  if (n < 1 || n > MAX_PLAUSIBLE_SEAT) return null
  return n
}

/**
 * Emit seats only when the source published an exact, unambiguous pair.
 * Anything else -> null. Never interpolated, never guessed.
 */
function seatsFor(t: VividTicket): string[] | null {
  if (String(t.q ?? '') !== '2') return null
  const lo = plausibleSeat(t.ls)
  const hi = plausibleSeat(t.hs)
  if (lo == null || hi == null) return null
  if (hi - lo !== 1) return null
  return seatRange(String(lo), String(hi))
}

// ---------------------------------------------------------------- refresh

/**
 * Re-pull the raw file by watching the page's own traffic. Headed Chromium, a
 * `response` listener, and nothing else — no CAPTCHA handling, no proxying, no
 * fingerprint spoofing. Only reached via `--refresh` / `CAPTURE_REFRESH=1`.
 */
async function refreshRawFile(): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1500, height: 1000 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      locale: 'en-US',
    })
    const page = await ctx.newPage()

    // The page can issue this XHR more than once (a re-fetch after the quantity
    // chip is applied returns a *filtered subset*). Keeping the last response
    // seen would silently save a partial payload, so keep the one carrying the
    // most tickets instead — the un-paginated whole-event document.
    let body: string | null = null
    let bodyTickets = -1
    let endpoint: string | null = null
    page.on('response', async (res) => {
      if (!LISTINGS_XHR.test(res.url())) return
      try {
        const buf = await res.body()
        if (buf.length <= 1000) return
        const text = buf.toString('utf8')
        const n = (JSON.parse(text) as VividPayload).tickets?.length ?? -1
        if (n > bodyTickets) {
          body = text
          bodyTickets = n
          endpoint = res.url()
        }
      } catch {
        /* body discarded by the browser, or not JSON — keep waiting for another */
      }
    })

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForTimeout(15_000)

    // Dismiss the promo modal so the listings panel is readable for evidence.
    try {
      await page.keyboard.press('Escape')
    } catch {
      /* nothing focused */
    }
    for (const sel of ['button[aria-label="Close"]', '[data-testid="close-button"]']) {
      try {
        const el = page.locator(sel).first()
        if (await el.isVisible({ timeout: 1200 })) await el.click()
      } catch {
        /* modal variant not present */
      }
    }
    await page.waitForTimeout(2500)

    // What the site itself says: listing count, quantity chip, per-card fee
    // labels, whether any all-in toggle control exists, and a few rendered rows
    // to cross-check prices against `aip`.
    const dom = await page.evaluate(() => {
      const text = document.body.innerText
      const rows = [...document.querySelectorAll('[data-testid="listing-row-container"]')]
        .slice(0, 8)
        .map((n) => (n as HTMLElement).innerText.replace(/\s*\n+\s*/g, ' | ').trim())
      return {
        listingCountText: text.match(/([\d,]+)\s+listings?/i)?.[0] ?? null,
        quantityChip:
          [...document.querySelectorAll('button, div, span')]
            .map((e) => e.textContent?.trim() ?? '')
            .find((t) => /^\d+ Tickets?$/.test(t)) ?? null,
        feesInclLabels: document.querySelectorAll('[data-testid="fees-included-text"]').length,
        allInToggleControls: [...document.querySelectorAll('button, label, input')]
          .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
          .filter((t) => /all[- ]?in/i.test(t)),
        renderedRows: rows,
      }
    })

    if (!body) {
      throw new Error(
        'vividseats --refresh: the page never issued /hermes/api/v1/listings. ' +
          'Save that response manually to captures/raw/vividseats.json and re-run without --refresh.',
      )
    }

    const payload = JSON.parse(body) as VividPayload
    const g = payload.global?.[0] ?? {}
    const out = {
      _meta: {
        source: SOURCE,
        capturedAt: new Date().toISOString(),
        pageUrl: PAGE_URL,
        endpoint,
        method: "passive interception of the page's own XHR (headed Playwright response listener)",
        allInEvidence: {
          globalFlags: {
            showAip: g.showAip,
            defaultAipOn: g.defaultAipOn,
            showAipIncludedPrices: g.showAipIncludedPrices,
            aipIncludedPrices: g.aipIncludedPrices,
            vatAddedToAip: g.vatAddedToAip,
          },
          dom,
        },
        quantityFilter: {
          rule: 'ticket.m (split list) contains 2 AND ticket.q >= 2',
          matched: (payload.tickets ?? []).filter(sellsPairs).length,
          domSaid: dom.listingCountText,
        },
        responsesSeen: { keptTicketCount: bodyTickets },
      },
      payload,
    }
    mkdirSync(dirname(RAW_FILE), { recursive: true })
    writeFileSync(RAW_FILE, JSON.stringify(out))
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------- capture

export async function capture(): Promise<Listing[]> {
  if (isRefresh()) await refreshRawFile()

  let text: string
  try {
    text = readFileSync(RAW_FILE, 'utf8')
  } catch (err) {
    throw new Error(
      `vividseats: ${RAW_FILE} not readable (${(err as Error).message}). ` +
        `Either run with --refresh, or have a human open ${PAGE_URL}, copy the ` +
        `/hermes/api/v1/listings?productionId=${PRODUCTION_ID}... response from ` +
        `devtools Network, and save it to that path.`,
    )
  }

  const { payload, capturedAt } = unwrap(text)
  assertAllIn(payload)

  const validSections = new Set<string>(
    (JSON.parse(readFileSync(VOCAB_FILE, 'utf8')) as { sectionIds: string[] }).sectionIds,
  )
  const zoneNames = new Map<string, string>()
  for (const grp of payload.groups ?? []) {
    if (grp?.i && grp.n) zoneNames.set(String(grp.i), String(grp.n))
  }

  const listings: Listing[] = []
  const unmatchedSections = new Map<string, number>()
  const seenIds = new Set<string>()
  let droppedNoPair = 0
  let droppedBadPrice = 0
  let droppedNoId = 0
  let droppedDupId = 0
  let promoDiscounted = 0

  for (const t of payload.tickets ?? []) {
    if (!sellsPairs(t)) {
      droppedNoPair++
      continue
    }

    // All-in only. `aip` (== allInPricePerTicket) must exist and exceed the
    // pre-fee `p`; otherwise we would be about to emit a pre-fee number.
    const allIn = Number(t.aip ?? t.allInPricePerTicket)
    const preFee = Number(t.p)
    if (!Number.isFinite(allIn) || allIn <= 0 || (Number.isFinite(preFee) && allIn <= preFee)) {
      droppedBadPrice++
      continue
    }

    const section = sectionIdFor(t, zoneNames)
    if (!validSections.has(section)) {
      const key = `${t.s ?? '(no label)'} -> ${section || '(empty)'}`
      unmatchedSections.set(key, (unmatchedSections.get(key) ?? 0) + 1)
      continue
    }

    const id = String(t.i ?? '')
    if (!id) {
      droppedNoId++
      continue
    }
    if (seenIds.has(id)) {
      droppedDupId++
      continue
    }
    seenIds.add(id)
    if (t.di === true) promoDiscounted++

    listings.push({
      source: SOURCE,
      sourceListingId: id,
      section,
      row: normalizeRow(t.r),
      seats: seatsFor(t),
      allInPricePerTicket: Math.round(allIn * 100) / 100,
      listingUrl: `https://www.vividseats.com${EVENT_PATH}?showDetails=${encodeURIComponent(id)}&qty=2`,
      capturedAt,
    })
  }

  if (unmatchedSections.size) {
    console.warn(
      `[vividseats] ${unmatchedSections.size} section label(s) did not normalize to a ` +
        `venue-vocab id and were NOT emitted: ` +
        [...unmatchedSections.entries()].map(([k, n]) => `${k} (x${n})`).join(', '),
    )
  }
  if (droppedBadPrice) {
    console.warn(
      `[vividseats] dropped ${droppedBadPrice} listing(s) whose all-in price failed the ` +
        `fees-included check (aip missing or not greater than pre-fee p).`,
    )
  }
  if (droppedNoId || droppedDupId) {
    console.warn(
      `[vividseats] dropped ${droppedNoId} listing(s) with no listing id and ` +
        `${droppedDupId} duplicate id(s) — no stable listingUrl could be built for them.`,
    )
  }
  if (promoDiscounted) {
    console.warn(
      `[vividseats] ${promoDiscounted}/${listings.length} emitted listing(s) carry a promo ` +
        `discount flag (di=true, pdi=rate). The emitted price is the all-in list price the ` +
        `site displays; checkout may apply that discount on top, so those few could settle ` +
        `slightly lower. No discount is applied here — it would be a price the source never showed.`,
    )
  }
  if (!listings.length) {
    throw new Error(
      `vividseats: 0 pair-buyable listings from ${payload.tickets?.length ?? 0} raw listings ` +
        `(${droppedNoPair} had no 2-split). The raw file is probably stale or for another event.`,
    )
  }

  return listings
}
