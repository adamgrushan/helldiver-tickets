/**
 * StubHub capture.
 *
 * Access: StubHub returns 403 on the event document to this machine's plain
 * Playwright Chromium — the listings page never renders, so passive
 * interception has nothing to observe. What works is driving a real Google
 * Chrome over CDP with a dedicated profile, where a human can clear the
 * one-time interstitial; after that the page's own paginating POST is
 * observable. That capture is already saved, so this module parses the file.
 *
 *   captures/raw/stubhub.json  { _meta, pages: [{ estimatedFees, items[] }] }
 *
 * The grid is paginated 10 at a time behind
 * `POST <event url> {"Method":"IndexShGridOnly", ...}`; the saved payload holds
 * all 34 pages.
 *
 * ALL-IN PRICING — read this before touching the price field.
 *
 * StubHub defaults to pre-fee prices. All-in is the `estimatedFees=true` URL
 * param (equivalently the site's fee toggle), and when it is on, `item.rawPrice`
 * *becomes* the fee-inclusive per-ticket price — the same field, a different
 * meaning. There is no separate all-in field to prefer, which makes reading
 * `rawPrice` without proving the flag was set the single easiest way to leak a
 * pre-fee price. So the flag is asserted, per page, before any price is read.
 *
 * The capture recorded the toggle's effect directly: `priceDisplayStrategy`
 * moved 0 -> 2, the grid's minimum price moved $234 -> $285.89, and per-listing
 * before/after pairs are kept in `_meta.allIn.feePairs` (fees run ~21.8%).
 *
 * Caveat, stated rather than smoothed over: StubHub does not itemize tax here —
 * `formattedFees` comes back empty and no tax field exists — so unlike
 * Ticketmaster, "pre-tax" cannot be independently verified for this source.
 * `rawPrice` is the fee-inclusive figure StubHub itself shows the buyer, which
 * is the comparable number; it is used as-is and this limitation is documented
 * in the README.
 */
import { readFileSync, existsSync } from 'node:fs'
import type { Listing } from '../../src/types.ts'
import { normalizeSection, normalizeRow, seatRange } from '../lib/normalize.ts'

const RAW = 'captures/raw/stubhub.json'
const EVENT_URL =
  'https://www.stubhub.com/us-open-tennis-flushing-tickets-9-10-2026/event/159351469/?quantity=2&estimatedFees=true'
const QUANTITY = 2

type Item = {
  id: number
  section?: string
  sectionMapName?: string
  row?: string
  seatFrom?: string
  seatTo?: string
  hasSeatDetails?: boolean
  availableQuantities?: number[]
  maxQuantity?: number
  availableTickets?: number
  rawPrice?: number
  formattedTotalPrice?: string
}
type Page = { currentPage?: number; estimatedFees?: boolean; items?: Item[] }
type Raw = {
  _meta?: {
    capturedAt?: string
    allIn?: {
      gridEstimatedFees?: boolean
      priceDisplayStrategyAllInOn?: number
      priceDisplayStrategyAllInOff?: number
      minPriceAllInOn?: number
      minPriceAllInOff?: number
    }
  }
  _capture?: { status?: string; blockedBy?: string; humanTodo?: string[] }
  pages?: Page[]
}

/**
 * Refuse to read any price unless the capture proves all-in was on.
 * `rawPrice` is pre-fee when the flag is off, so this is the pre-fee guard.
 */
function assertAllIn(raw: Raw): void {
  const a = raw._meta?.allIn
  if (!a) {
    throw new Error(
      `${RAW} has no _meta.allIn evidence — cannot prove prices are fee-inclusive, refusing to emit`,
    )
  }
  if (a.gridEstimatedFees !== true) {
    throw new Error(
      `${RAW}: gridEstimatedFees=${a.gridEstimatedFees}; rawPrice would be PRE-FEE, refusing to emit`,
    )
  }
  // The toggle must have visibly changed the prices, not merely been requested.
  if (
    typeof a.minPriceAllInOn === 'number' &&
    typeof a.minPriceAllInOff === 'number' &&
    !(a.minPriceAllInOn > a.minPriceAllInOff)
  ) {
    throw new Error(
      `${RAW}: all-in min ${a.minPriceAllInOn} did not exceed pre-fee min ${a.minPriceAllInOff} — the toggle did not take effect`,
    )
  }
}

export async function capture(): Promise<Listing[]> {
  if (!existsSync(RAW)) {
    throw new Error(
      `${RAW} is missing. StubHub 403s this machine; capture it in a real browser ` +
        'and save the grid response there (see README).',
    )
  }
  const raw: Raw = JSON.parse(readFileSync(RAW, 'utf8'))

  // The file doubles as the record of a blocked attempt.
  if (raw._capture?.status === 'blocked') {
    throw new Error(
      `StubHub capture is BLOCKED (${raw._capture.blockedBy}). ${RAW} holds the ` +
        'block evidence, not inventory. A human must save a real payload:\n  ' +
        (raw._capture.humanTodo ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n  '),
    )
  }
  if (!raw.pages?.length) throw new Error(`${RAW} contains no pages`)

  assertAllIn(raw)

  const capturedAt = raw._meta?.capturedAt ?? new Date().toISOString()
  const listings: Listing[] = []
  const seen = new Set<number>()
  const dropped = { notPairable: 0, noPrice: 0, noSection: 0, totalMismatch: 0 }

  for (const page of raw.pages) {
    // Per-page guard: a page fetched with the toggle off would carry pre-fee
    // prices even if the run as a whole had it on.
    if (page.estimatedFees !== true) {
      throw new Error(
        `${RAW}: page ${page.currentPage} has estimatedFees=${page.estimatedFees}; ` +
          'its rawPrice values are pre-fee, refusing to emit',
      )
    }

    for (const item of page.items ?? []) {
      // The grid pages overlap, so the same listing arrives more than once.
      if (seen.has(item.id)) continue
      seen.add(item.id)

      // Exactly two together. The quantity=2 URL param is not proof on its own —
      // this is the per-listing check.
      const qtys = item.availableQuantities ?? []
      if (!qtys.includes(QUANTITY)) {
        dropped.notPairable++
        continue
      }

      const section = normalizeSection(item.section ?? item.sectionMapName)
      if (!section) {
        dropped.noSection++
        continue
      }

      const allIn = item.rawPrice
      if (typeof allIn !== 'number' || !(allIn > 0)) {
        dropped.noPrice++
        continue
      }

      // StubHub prints the pair total alongside the per-ticket price; if they
      // disagree, one of them isn't what we think it is.
      const total = Number(String(item.formattedTotalPrice ?? '').replace(/[^0-9.]/g, ''))
      if (Number.isFinite(total) && total > 0 && Math.abs(total - allIn * QUANTITY) > 1.5) {
        dropped.totalMismatch++
        continue
      }

      listings.push({
        source: 'stubhub',
        sourceListingId: String(item.id),
        section,
        row: normalizeRow(item.row),
        // seatFrom/seatTo are absent on listings StubHub won't name seats for.
        seats: seatRange(item.seatFrom, item.seatTo),
        allInPricePerTicket: Math.round(allIn * 100) / 100,
        listingUrl: EVENT_URL,
        capturedAt,
      })
    }
  }

  const summary = Object.entries(dropped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  if (summary) console.log(`[stubhub] dropped: ${summary}`)
  console.log(`[stubhub] ${listings.length} listings at qty ${QUANTITY}`)

  return listings
}
