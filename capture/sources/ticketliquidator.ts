/**
 * Ticket Liquidator (TicketNetwork white-label, Seatics map widget).
 *
 * Event: 2026 US Open Tennis Championships — Session 23
 *        (Women's Singles Semifinals), Arthur Ashe Stadium, Thu Sep 10 2026 7pm.
 *
 * ── How the data is obtained ───────────────────────────────────────────────
 * The page has no separate listings XHR of its own making that we can call:
 * inventory arrives as **JSONP** from the Seatics/TicketNetwork endpoint
 *
 *     https://mapwidget3.seatics.com/Api/TicketsByEvent
 *         ?callback=Seatics.Coordinator.gotTicketsCallback
 *         &eventId=7396871&websiteConfigId=237
 *
 * as an array of *positional tuples*. Rather than guess tuple offsets, the
 * capture reads the page's own already-parsed objects out of
 * `Seatics.Presentation.TicketsList.currentSegments[*].tickets`, which carry
 * named fields (`tgID`, `tgUserSec`, `tgUserRow`, `tgUserSeats`, `tgQty`,
 * `splits`, `tgPrice`, `tgServiceFee`, `tgDeliveryFee`, `tgAllInPrice`,
 * `tgDisplayPrice`). Both forms are preserved in the raw file: the verbatim
 * JSONP body in `ticketsByEventJsonp`, the named objects in `ticketGroups`.
 * Everything is passive — page load only, no synthetic API call, no spoofing.
 *
 * ── All-in pricing ────────────────────────────────────────────────────────
 * This white-label runs fee-inclusive pricing *forced on*:
 * `Seatics.config.includeServiceFeesInTicketPrice === true`, the list carries
 * `sea-list-all-in-banner-show`, and the "Show prices with estimated fees"
 * switch is present with class `switch active` but is not rendered in the
 * desktop layout, so it cannot be off. Proof is arithmetic and visual: the row
 * for tgID 552363354 (Upper 325, Row Z) shows headline **"$321 each"** over its
 * own itemization **"Ticket Price $245 + Fee $75.95 + Taxes if applicable"**;
 * 245 + 75.95 = 320.95 = `tgAllInPrice` = `tgDisplayPrice`, and $321 is that
 * rounded for display. Fees in, tax out — exactly the contract's definition.
 *
 *     allInPricePerTicket = tgAllInPrice = tgPrice + tgServiceFee + tgDeliveryFee
 *
 * `assertAllInPricing()` below re-derives that identity for every group it
 * emits and throws if it ever fails, so a pre-fee price can never escape.
 *
 * ── Exactly 2 together ────────────────────────────────────────────────────
 * `splits` is the list of quantities a group may actually be bought in, so the
 * per-listing test is `splits.includes(2) && tgQty >= 2`. That is stricter than
 * availability: a group with `tgQty 3` and `splits [1, 3]` is rejected. On the
 * captured snapshot this selected exactly the same 354 ticket-group ids as the
 * site's own quantity=2 filter — set-equal, no diff in either direction (see
 * `siteQuantity2Filter.ids` in the raw file, and `crossCheckAgainstSiteFilter`).
 *
 * ── Seats ─────────────────────────────────────────────────────────────────
 * `tgUserSeats` is either masked (`*-*`, 197 of 354 groups) → `seats: null`, or
 * a `from-to` range covering the **whole ticket group** (`15-16`, `1-4`).
 *
 * Seat numbers are therefore only emitted when that range *is* the pair we are
 * buying (span === 2, 86 of 354). Where the group is bigger than the pair
 * (`1-4`, qty 4, splits [2,4]) the source does not publish *which* two of those
 * seats a buyer of 2 receives, so `seats` is `null`: putting all four numbers on
 * a two-ticket listing would over-claim the inventory, color seats on the map
 * the listing may not include, and defeat the seat-level veto in `dedupe.ts`
 * (which treats two differing seat sets as definitively different inventory).
 * `null` is what the type means by "the source doesn't publish seat numbers",
 * and it still tints the whole section on the map. No seat number is ever
 * synthesized, and the group's published range stays in the raw file.
 */

import type { Listing, Source } from '../../src/types.ts'
import { normalizeRow, normalizeSection, seatRange } from '../lib/normalize.ts'
import { readFile, writeFile } from 'node:fs/promises'

const SOURCE: Source = 'ticketliquidator'

const RAW_PATH = new URL('../../captures/raw/ticketliquidator.json', import.meta.url)
const VOCAB_PATH = new URL('../lib/venue-vocab.json', import.meta.url)

/** The event page. `#open` makes the widget open straight onto the ticket list. */
const EVENT_URL =
  'https://www.ticketliquidator.com/tickets/7396871/' +
  '2026-us-open-tennis-championships-session-23-tickets-thu-sep-10-2026-arthur-ashe-stadium#open'

/** Seatics checkout deep-link keys, read from `Seatics.config` on the live page. */
const DEEP_LINK_TG_KEY = 'tgid'
const DEEP_LINK_QTY_KEY = 'qty'

const WANTED_QUANTITY = 2

/** Non-admission inventory the widget mixes into the same feed (LOT E parking). */
const NON_ADMISSION_SECTION = /(^|\b)(LOT|PARKING|PASS)\b/i

// ---------------------------------------------------------------- raw shapes

/** One Seatics ticket group, as the page's own widget parsed it. */
type TicketGroup = {
  tgID: number | string
  tgUserSec: string
  tgUserRow: string | null
  tgUserSeats: string | null
  tgQty: number
  splits: number[] | null
  tgPrice: number
  tgServiceFee: number
  tgDeliveryFee: number
  tgAllInPrice: number
  tgDisplayPrice: number
  tgNotes?: string | null
  tgIsAda?: boolean
  tgIsZoneTicket?: boolean
}

type AllInEvidence = {
  configFlag_includeServiceFeesInTicketPrice?: boolean
  listContainerClass?: string | null
  allInSwitchClass?: string | null
  probeListingId?: string
  displayedHeadlinePrice?: string | null
  displayedRowText?: string | null
  tgPrice?: number | null
  tgServiceFee?: number | null
  tgDeliveryFee?: number | null
  tgAllInPrice?: number | null
  tgDisplayPrice?: number | null
}

type RawCapture = {
  source: string
  capturedAt: string
  eventUrl?: string
  endpointUrl?: string
  allInEvidence: AllInEvidence
  siteQuantity2Filter?: { ids?: string[] }
  ticketGroups: TicketGroup[]
  ticketsByEventJsonp?: string
}

type Vocab = { sectionIds: string[] }

// ------------------------------------------------------------------ helpers

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Refuse to emit anything unless the capture provably ran with fee-inclusive
 * pricing on. Checked once for the whole file, then per group.
 */
function assertAllInPricing(raw: RawCapture): void {
  const ev = raw.allInEvidence
  if (!ev || ev.configFlag_includeServiceFeesInTicketPrice !== true) {
    throw new Error(
      'ticketliquidator: raw capture does not prove all-in pricing was on ' +
        '(allInEvidence.configFlag_includeServiceFeesInTicketPrice !== true); refusing to emit prices',
    )
  }
  if (!(ev.listContainerClass ?? '').includes('sea-list-all-in-banner-show')) {
    throw new Error(
      'ticketliquidator: the ticket list was not rendering the all-in banner ' +
        `(listContainerClass=${JSON.stringify(ev.listContainerClass)}); refusing to emit prices`,
    )
  }
  // The recorded probe row must reconcile: headline == round(price + fees).
  // These numbers are mandatory, not best-effort: without them the only
  // evidence left is a config flag, and a flag alone has never been enough to
  // trust a price. A raw file that lacks them is refused.
  const { tgPrice, tgServiceFee, tgDeliveryFee, tgAllInPrice, displayedHeadlinePrice } = ev
  if (!isFiniteNumber(tgPrice) || !isFiniteNumber(tgServiceFee) || !isFiniteNumber(tgAllInPrice)) {
    throw new Error(
      'ticketliquidator: raw capture carries no priced probe row ' +
        '(allInEvidence.tgPrice/tgServiceFee/tgAllInPrice); cannot prove fee-inclusive ' +
        'pricing arithmetically, so refusing to emit prices',
    )
  }
  const derived = round2(tgPrice + tgServiceFee + (tgDeliveryFee ?? 0))
  if (Math.abs(derived - tgAllInPrice) > 0.011) {
    throw new Error(
      `ticketliquidator: probe listing ${ev.probeListingId} does not reconcile: ` +
        `${tgPrice} + ${tgServiceFee} + ${tgDeliveryFee ?? 0} = ${derived} != tgAllInPrice ${tgAllInPrice}`,
    )
  }
  // A fee of zero would mean the arithmetic proves nothing — the pre-fee and
  // all-in prices would be identical and this module could not tell them apart.
  if (tgServiceFee <= 0) {
    throw new Error(
      `ticketliquidator: probe listing ${ev.probeListingId} carries no service fee ` +
        '(tgServiceFee = 0), so the capture cannot demonstrate fees are included',
    )
  }
  // The price the site actually printed must be the all-in one, not tgPrice.
  // (The site rounds the headline to whole dollars, hence the $1 tolerance.)
  const headline = Number(String(displayedHeadlinePrice ?? '').replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(headline) || headline <= 0) {
    throw new Error(
      'ticketliquidator: raw capture recorded no displayed headline price for probe ' +
        `listing ${ev.probeListingId}; refusing to emit prices without the visual check`,
    )
  }
  if (Math.abs(headline - tgAllInPrice) > 1) {
    throw new Error(
      `ticketliquidator: the price the site displayed (${displayedHeadlinePrice}) is not the ` +
        `all-in price (${tgAllInPrice}) — pricing mode is not what this module assumes`,
    )
  }
}

/** Purchasable as exactly `WANTED_QUANTITY` tickets together. */
function buyableAsPair(tg: TicketGroup): boolean {
  const splits = Array.isArray(tg.splits) ? tg.splits.map(Number) : []
  return splits.includes(WANTED_QUANTITY) && Number(tg.tgQty) >= WANTED_QUANTITY
}

/**
 * Seat numbers for a listing that is a purchase of exactly `WANTED_QUANTITY`.
 *
 * `*-*` means the seller published no seat numbers at all. Anything else is a
 * `from-to` range covering the whole ticket group — so it only identifies this
 * listing's seats when the group *is* the pair. For a larger group the source
 * does not publish which two seats a buyer of 2 gets, and guessing a pair (or
 * reporting all of them as if they were the pair) would be inventing data.
 */
function seatsOf(tgUserSeats: string | null | undefined): string[] | null {
  const s = String(tgUserSeats ?? '').trim()
  if (!s || s.includes('*')) return null
  const [from, to] = s.split('-', 2)
  const seats = seatRange(from?.trim(), (to ?? from)?.trim())
  if (!seats || seats.length !== WANTED_QUANTITY) return null
  return seats
}

function listingUrlFor(tgID: number | string): string {
  const base = EVENT_URL.replace(/#.*$/, '')
  return `${base}?${DEEP_LINK_TG_KEY}=${encodeURIComponent(String(tgID))}` +
    `&${DEEP_LINK_QTY_KEY}=${WANTED_QUANTITY}`
}

// ------------------------------------------------------------------ parsing

type ParseReport = {
  listings: Listing[]
  totalGroups: number
  rejectedNotPair: number
  rejectedNonAdmission: number
  unmatchedSections: Map<string, number>
  priceProblems: string[]
  /** Groups that published a seat range wider than the pair -> `seats: null`. */
  seatRangeWiderThanPair: number
}

function parseRaw(raw: RawCapture, vocab: Set<string>): ParseReport {
  const listings: Listing[] = []
  const unmatchedSections = new Map<string, number>()
  const priceProblems: string[] = []
  let rejectedNotPair = 0
  let rejectedNonAdmission = 0
  let seatRangeWiderThanPair = 0

  const capturedAt = raw.capturedAt ?? new Date().toISOString()
  const groups = Array.isArray(raw.ticketGroups) ? raw.ticketGroups : []

  for (const tg of groups) {
    if (!buyableAsPair(tg)) {
      rejectedNotPair += 1
      continue
    }
    // Parking passes / zone placeholders share the feed but are not admission.
    if (NON_ADMISSION_SECTION.test(String(tg.tgUserSec ?? '')) || tg.tgIsZoneTicket === true) {
      rejectedNonAdmission += 1
      continue
    }

    const section = normalizeSection(tg.tgUserSec)
    if (!vocab.has(section)) {
      const key = `${tg.tgUserSec} -> ${section || '(empty)'}`
      unmatchedSections.set(key, (unmatchedSections.get(key) ?? 0) + 1)
      continue
    }

    // Re-derive all-in per ticket and refuse anything that doesn't reconcile.
    const price = Number(tg.tgPrice)
    const serviceFee = Number(tg.tgServiceFee ?? 0)
    const deliveryFee = Number(tg.tgDeliveryFee ?? 0)
    const allIn = Number(tg.tgAllInPrice)
    const derived = round2(price + serviceFee + deliveryFee)
    if (!isFiniteNumber(allIn) || allIn <= 0) {
      priceProblems.push(`${tg.tgID}: tgAllInPrice not a usable number (${tg.tgAllInPrice})`)
      continue
    }
    if (Math.abs(derived - allIn) > 0.011) {
      priceProblems.push(
        `${tg.tgID}: ${price} + ${serviceFee} + ${deliveryFee} = ${derived} != tgAllInPrice ${allIn}`,
      )
      continue
    }
    if (isFiniteNumber(tg.tgDisplayPrice) && Math.abs(Number(tg.tgDisplayPrice) - allIn) > 0.011) {
      priceProblems.push(
        `${tg.tgID}: tgDisplayPrice ${tg.tgDisplayPrice} != tgAllInPrice ${allIn} (site would show a different price)`,
      )
      continue
    }

    const seats = seatsOf(tg.tgUserSeats)
    const published = String(tg.tgUserSeats ?? '')
    if (seats === null && published && !published.includes('*')) seatRangeWiderThanPair += 1

    listings.push({
      source: SOURCE,
      sourceListingId: String(tg.tgID),
      section,
      row: normalizeRow(tg.tgUserRow),
      seats,
      allInPricePerTicket: round2(allIn),
      listingUrl: listingUrlFor(tg.tgID),
      capturedAt,
    })
  }

  return {
    listings,
    totalGroups: groups.length,
    rejectedNotPair,
    rejectedNonAdmission,
    unmatchedSections,
    priceProblems,
    seatRangeWiderThanPair,
  }
}

/**
 * The site's own quantity=2 filter was recorded alongside the inventory.
 *
 * Compared against what `splits.includes(2)` selected — a `quantity=2` filter is
 * not always honored, and neither check is trusted on its own. The comparison is
 * made on the *pair test* set, not on the emitted listings, so drops for
 * unrelated reasons (non-admission, unknown section, price that would not
 * reconcile) don't show up as a phantom quantity disagreement.
 *
 * The two witnesses are then AND-ed rather than merely reported: anything our
 * splits test kept but the site's own filter refused to show at qty=2 is
 * **removed**, because the contract's bar is inventory genuinely purchasable as
 * exactly 2 and one witness disagreeing is enough to lose that. Returns the
 * listings that survive.
 */
function crossCheckAgainstSiteFilter(raw: RawCapture, listings: Listing[]): Listing[] {
  const siteIds = raw.siteQuantity2Filter?.ids
  if (!Array.isArray(siteIds) || siteIds.length === 0) {
    console.warn(
      '[ticketliquidator] no site quantity=2 filter recorded in the raw file — the splits test ' +
        'is the only quantity witness for this capture',
    )
    return listings
  }
  const site = new Set(siteIds.map(String))
  const pairIds = new Set(
    raw.ticketGroups.filter((tg) => buyableAsPair(tg)).map((tg) => String(tg.tgID)),
  )
  const onlyMine = [...pairIds].filter((id) => !site.has(id))
  const onlySite = [...site].filter((id) => !pairIds.has(id))
  console.log(
    `[ticketliquidator] qty=2 cross-check: splits-based ${pairIds.size}, site filter ${site.size}; ` +
      `only-ours ${onlyMine.length}, only-theirs ${onlySite.length}`,
  )
  if (onlySite.length) {
    console.warn(
      '[ticketliquidator]   the site showed at qty=2 but splits rejected (not emitted): ' +
        onlySite.slice(0, 10).join(', '),
    )
  }
  if (!onlyMine.length) return listings
  const dropped = listings.filter((l) => !site.has(l.sourceListingId))
  console.warn(
    `[ticketliquidator]   dropping ${dropped.length} listing(s) the site's own qty=2 filter did ` +
      `not show: ${dropped.map((l) => l.sourceListingId).slice(0, 10).join(', ')}`,
  )
  return listings.filter((l) => site.has(l.sourceListingId))
}

// ------------------------------------------------------------------ refresh

/**
 * Re-pull live and overwrite the raw file. Opt in with `--refresh` on the argv
 * or `TL_REFRESH=1`; the default path only ever reads the saved file.
 * Playwright is imported dynamically so merely importing this module stays free.
 */
async function refreshRawFile(): Promise<void> {
  const { chromium } = await import('playwright')
  const probeTgId = '552363354'

  // Headed: this site treats headless harshly.
  const browser = await chromium.launch({ headless: false })
  try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 980 } })).newPage()

    let jsonp = ''
    let endpointUrl = ''
    page.on('response', async (res) => {
      if (!res.url().includes('/Api/TicketsByEvent')) return
      endpointUrl = res.url()
      try {
        jsonp = await res.text()
      } catch {
        /* the body may already be gone; the named objects are the primary source */
      }
    })

    await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page
      .waitForFunction(() => (globalThis as Record<string, unknown>).mapHasFinishedRendering === true, {
        timeout: 90_000,
      })
      .catch(() => {
        throw new Error('ticketliquidator: the Seatics map never finished rendering')
      })
    await page.waitForTimeout(4500)
    // Decline non-essential cookies.
    await page.locator('button:has-text("Reject All")').first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1200)

    const allInEvidence = await page.evaluate((id) => {
      const S = (globalThis as Record<string, any>).Seatics
      const tr = document.querySelector(`tr[data-id="${id}"]`) as HTMLElement | null
      const tg = (S?.Presentation?.TicketsList?.currentSegments ?? [])
        .flatMap((s: any) => s.tickets ?? [])
        .find((t: any) => String(t.tgID) === id)
      return {
        configFlag_includeServiceFeesInTicketPrice: S?.config?.includeServiceFeesInTicketPrice,
        configFlag_showAllInPricingToggle: S?.config?.showAllInPricingToggle,
        allInSwitchClass:
          (document.querySelector('.sea-all-in-pricing-option') as HTMLElement | null)?.className ?? null,
        allInSwitchRendered:
          (document.querySelector('.sea-all-in-pricing-option') as HTMLElement | null)?.offsetParent !== null,
        listContainerClass: (document.querySelector('#list-ctn') as HTMLElement | null)?.className ?? null,
        probeListingId: id,
        displayedHeadlinePrice:
          (tr?.querySelector('.venue-ticket-list-cta-amt') as HTMLElement | null)?.innerText?.trim() ?? null,
        displayedRowText: tr?.innerText.replace(/\s+/g, ' ').trim() ?? null,
        tgPrice: tg?.tgPrice ?? null,
        tgServiceFee: tg?.tgServiceFee ?? null,
        tgDeliveryFee: tg?.tgDeliveryFee ?? null,
        tgAllInPrice: tg?.tgAllInPrice ?? null,
        tgDisplayPrice: tg?.tgDisplayPrice ?? null,
      }
    }, probeTgId)

    if (allInEvidence.configFlag_includeServiceFeesInTicketPrice !== true) {
      // The white-label forces it on; if that ever changes, click the switch.
      await page.click('#sea-all-in-pricing-toggle-btn', { timeout: 5000 })
      await page.waitForTimeout(2500)
      const on = await page.evaluate(
        () => (globalThis as Record<string, any>).Seatics?.config?.includeServiceFeesInTicketPrice,
      )
      if (on !== true) throw new Error('ticketliquidator: could not turn all-in pricing on')
      allInEvidence.configFlag_includeServiceFeesInTicketPrice = true
    }

    // Unfiltered inventory, every type tab, named fields.
    // The Seatics ticket objects are circular (`section.level.sections[…]`), so
    // only scalars and scalar arrays are copied out, plus the two ids we want.
    const ticketGroups = await page.evaluate(async () => {
      const isScalar = (v: unknown) =>
        v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)
      const dump = (t: Record<string, any>) => {
        const o: Record<string, unknown> = {}
        for (const k of Object.keys(t)) {
          const v = t[k]
          if (isScalar(v)) o[k] = v
          else if (Array.isArray(v) && v.every(isScalar)) o[k] = v
        }
        o.sectionId = t.section?.id ?? null
        o.sectionName = t.section?.name ?? null
        return o
      }
      const S = (globalThis as Record<string, any>).Seatics
      const tabs = Array.from(
        document.querySelectorAll<HTMLElement>('.sea-tg-type-item, .sea-inventory-slider .slick-slide'),
      )
      const byId = new Map<string, Record<string, unknown>>()
      const collect = () => {
        for (const seg of S?.Presentation?.TicketsList?.currentSegments ?? []) {
          for (const t of seg.tickets ?? []) {
            const id = String((t as { tgID: unknown }).tgID)
            if (!byId.has(id)) byId.set(id, dump(t))
          }
        }
      }
      collect()
      for (const tab of tabs) {
        tab.click()
        await new Promise((r) => setTimeout(r, 2200))
        collect()
      }
      tabs[0]?.click()
      return [...byId.values()]
    })

    // Then apply the site's own quantity=2 filter, for the cross-check.
    await page.waitForTimeout(2000)
    await page.evaluate(() => {
      const l2 = Array.from(document.querySelectorAll<HTMLElement>('label.qty-filter-opt-label-js')).find(
        (l) => l.innerText.trim() === '2',
      )
      l2?.click()
      const r2 = Array.from(document.querySelectorAll<HTMLInputElement>('input.qty-filter-opt-js')).find(
        (r) => r.value === '2',
      )
      if (r2) {
        r2.checked = true
        r2.dispatchEvent(new Event('change', { bubbles: true }))
        r2.dispatchEvent(new Event('click', { bubbles: true }))
      }
    })
    await page.waitForTimeout(1500)
    await page.locator('#sea-filterCard-submit-btn').first().click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(4000)

    const siteQuantity2Filter = await page.evaluate(() => {
      const S = (globalThis as Record<string, any>).Seatics
      const segs = S?.Presentation?.TicketsList?.currentSegments ?? []
      return {
        requested: 2,
        activeQtyLabels: Array.from(
          document.querySelectorAll<HTMLElement>('label.qty-filter-opt-label-js'),
        ).map((l) => `${l.innerText.trim()}${/\bactive\b|sea-active/.test(l.className) ? ':ACTIVE' : ''}`),
        ids: segs.flatMap((s: any) => (s.tickets ?? []).map((t: any) => String(t.tgID))),
        domRows: Array.from(document.querySelectorAll('tr[data-id]')).map((tr) => ({
          id: tr.getAttribute('data-id'),
          text: (tr as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
          headline:
            (tr.querySelector('.venue-ticket-list-cta-amt') as HTMLElement | null)?.innerText?.trim() ?? null,
        })),
      }
    })

    const raw = {
      source: SOURCE,
      capturedAt: new Date().toISOString(),
      event: {
        name: "2026 US Open Tennis Championships - Session 23 (Women's Singles Semifinals)",
        venue: 'Arthur Ashe Stadium, Flushing NY',
        startsAt: '2026-09-10T19:00:00-04:00',
        ticketLiquidatorEventId: '7396871',
      },
      eventUrl: EVENT_URL,
      endpointUrl,
      howCaptured:
        'Headed Playwright, passive. ticketsByEventJsonp is the verbatim body of the ' +
        "page's own mapwidget3.seatics.com/Api/TicketsByEvent response (JSONP, positional " +
        'tuples). ticketGroups[] is the same inventory as the page itself parsed it, with ' +
        'named fields, read unfiltered out of Seatics.Presentation.TicketsList.currentSegments.',
      pricingRule:
        'all-in per ticket, fees in, pre-tax = tgPrice + tgServiceFee + tgDeliveryFee = ' +
        'tgAllInPrice = tgDisplayPrice. Rows print "Ticket Price $X + Fee $Y + Taxes if ' +
        'applicable" under a "$Z each" headline where Z === round(X+Y).',
      quantityRule: 'purchasable as exactly 2 = splits.includes(2) && tgQty >= 2',
      allInEvidence,
      siteQuantity2Filter,
      ticketGroups,
      ticketsByEventJsonp: jsonp,
    }
    await writeFile(RAW_PATH, JSON.stringify(raw, null, 2))
    console.log(`[ticketliquidator] refreshed raw capture: ${ticketGroups.length} ticket groups`)
  } finally {
    await browser.close()
  }
}

// ------------------------------------------------------------------ capture

export async function capture(): Promise<Listing[]> {
  const wantsRefresh =
    process.argv.includes('--refresh') || process.env.TL_REFRESH === '1'
  if (wantsRefresh) await refreshRawFile()

  let rawText: string
  try {
    rawText = await readFile(RAW_PATH, 'utf8')
  } catch (err) {
    throw new Error(
      `ticketliquidator: no raw capture at ${RAW_PATH.pathname}. ` +
        'Re-pull with --refresh (or TL_REFRESH=1), or save the page\'s own ' +
        'mapwidget3.seatics.com/Api/TicketsByEvent response there by hand. ' +
        `Cause: ${(err as Error).message}`,
    )
  }

  const raw = JSON.parse(rawText) as RawCapture
  if (!Array.isArray(raw.ticketGroups)) {
    throw new Error('ticketliquidator: raw capture has no ticketGroups[] array')
  }

  // Never emit a price we cannot prove is all-in.
  assertAllInPricing(raw)

  const vocab = new Set(
    (JSON.parse(await readFile(VOCAB_PATH, 'utf8')) as Vocab).sectionIds.map((s) => normalizeSection(s)),
  )

  const report = parseRaw(raw, vocab)

  if (report.unmatchedSections.size > 0) {
    console.warn(
      `[ticketliquidator] ${report.unmatchedSections.size} section label(s) did not normalize into ` +
        'venue-vocab.json and were NOT emitted: ' +
        [...report.unmatchedSections.entries()].map(([k, n]) => `${k} (x${n})`).join(', '),
    )
  }
  if (report.priceProblems.length > 0) {
    console.warn(
      `[ticketliquidator] dropped ${report.priceProblems.length} group(s) whose price did not ` +
        `reconcile: ${report.priceProblems.slice(0, 5).join(' | ')}`,
    )
  }
  const withSeats = report.listings.filter((l) => l.seats !== null).length
  console.log(
    `[ticketliquidator] ${report.totalGroups} groups -> ${report.listings.length} listings ` +
      `(rejected: ${report.rejectedNotPair} not buyable as exactly 2, ` +
      `${report.rejectedNonAdmission} non-admission); ` +
      `${withSeats} with seat numbers, ${report.listings.length - withSeats} without ` +
      `(${report.seatRangeWiderThanPair} of those published a range wider than the pair, ` +
      'so which two seats a buyer gets is not knowable)',
  )

  return crossCheckAgainstSiteFilter(raw, report.listings)
}
