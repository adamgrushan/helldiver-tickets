/**
 * Ticketmaster capture.
 *
 * Approach: passive interception. The event page's own frontend calls the ISM
 * inventory API; we attach a response listener before navigating and record what
 * it fetches. A direct server-side fetch of those endpoints returns
 * 403 {"response":"dynamic_block"}, and a synthetic in-page fetch is refused by
 * the bot-detection wrapper — but watching the page's own traffic works. See
 * manifest/README.md.
 *
 * Two response shapes are needed and they must be joined:
 *
 *   A. facets?by=section...&show=places   -> { section, offers[], places[], count }
 *      Carries WHERE inventory is. Place ids are compressed as a nested trie.
 *   B. facets?by=...offer&embed=offer     -> _embedded.offer[] with prices
 *      Carries WHAT it costs, plus sellableQuantities.
 *
 * The join matters because primary ("Standard Ticket") offers carry no
 * section/row/seat of their own — only a price level. Without A they can't be
 * placed at all, and those are exactly the featured rows on the site's own panel.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Listing, Venue } from '../../src/types.ts'
import { normalizeSection, normalizeRow } from '../lib/normalize.ts'
import { expandAll } from '../lib/tmPlaces.ts'
import { openPacedSession, recordResponses } from '../lib/browser.ts'

const EVENT_ID = '1D00646DB471672F'
const EVENT_URL =
  'https://www.ticketmaster.com/womens-singles-semifinals-flushing-new-york-09-10-2026/event/1D00646DB471672F'
// Resolved against this file, not the process cwd: a cwd-relative path made
// `existsSync(RAW)` false whenever the orchestrator ran from anywhere else,
// which silently took the live-browser path instead of parsing the saved raw.
const ROOT = new URL('../../', import.meta.url)
const RAW = fileURLToPath(new URL('captures/raw/ticketmaster.json', ROOT))
const RAW_DIR = fileURLToPath(new URL('captures/raw/', ROOT))
const VENUE = fileURLToPath(new URL('src/data/venue.json', ROOT))
const VOCAB = fileURLToPath(new URL('capture/lib/venue-vocab.json', ROOT))
const QUANTITY = 2

type Charge = { reason: string; type: string; amount: number }
type Offer = {
  offerId: string
  inventoryType: 'primary' | 'resale'
  offerType?: string
  listingId?: string
  listPrice: number
  totalPrice?: number
  charges?: Charge[]
  sellableQuantities?: number[]
  section?: string
  row?: string
  seatFrom?: string
  seatTo?: string
}
type Facet = {
  section?: string
  offers?: string[]
  places?: string[]
  count?: number
  inventoryTypes?: string[]
  available?: boolean
}
type Raw = {
  eventId: string
  eventUrl: string
  capturedAt: string
  facets: Facet[]
  offers: Offer[]
}

/**
 * All-in per ticket: fees included, tax excluded.
 *
 * `totalPrice` is deliberately not used — for primary offers it folds in a
 * face_value_tax charge, which would overstate every primary row. Verified
 * against the site's own panel: this formula yields $1,409.00 and $279.60 where
 * the site shows $1,409.00 and $279.60; totalPrice would have shown $1,531.01.
 */
function allInPerTicket(o: Offer): number {
  const fees = (o.charges ?? [])
    .filter((c) => c.type === 'fee')
    .reduce((sum, c) => sum + c.amount, 0)
  return Math.round((o.listPrice + fees) * 100) / 100
}

/** Live capture: watch the page load and keep the inventory responses. */
async function fetchRaw(): Promise<Raw> {
  const sink: Array<{ url: string; status: number; body: string }> = []
  const session = await openPacedSession()
  try {
    recordResponses(session.page, /\/api\/ismds\/event\//, sink)
    await session.page.goto(EVENT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    })
    // Inventory arrives well after DOM ready, and more of it after the map is
    // interacted with. Paced rather than hammered.
    await session.beat(12_000)
    await session.page.mouse.move(700, 500)
    await session.beat(2_500)
    await session.page.mouse.wheel(0, 300)
    await session.beat(8_000)
  } finally {
    await session.close()
  }

  const facets: Facet[] = []
  const offers = new Map<string, Offer>()
  for (const r of sink) {
    if (r.status !== 200) continue
    let doc: {
      facets?: Facet[]
      _embedded?: { offer?: Offer[] }
    }
    try {
      doc = JSON.parse(r.body)
    } catch {
      continue
    }
    // Only facets carrying place data can place inventory on the map.
    for (const f of doc.facets ?? []) {
      if (f.places?.length && f.section) facets.push(f)
    }
    for (const o of doc._embedded?.offer ?? []) offers.set(o.offerId, o)
  }

  // Fail before writing. A page load that returns no inventory is uncommon but
  // real, and overwriting the saved payload with an empty one would destroy the
  // artifact that makes a capture reproducible (rule 7).
  if (!facets.length || !offers.size) {
    throw new Error(
      `ticketmaster: the page load produced ${facets.length} place-bearing facet(s) and ` +
        `${offers.size} offer(s) — leaving ${RAW} untouched. Retry, or save the ` +
        'offeradapter/services ismds facets responses there by hand.',
    )
  }

  const raw: Raw = {
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    capturedAt: new Date().toISOString(),
    facets,
    offers: [...offers.values()],
  }
  mkdirSync(RAW_DIR, { recursive: true })
  writeFileSync(RAW, JSON.stringify(raw))
  return raw
}

/**
 * Two seats are a pair only if they are physically next to each other. Resale
 * offers publish a contiguous block so this is automatic, but a primary offer
 * is a price level: the seats left in a row at that level can be scattered
 * singles (section 120 row S had only seats 1 and 10 free — nine seats apart).
 * Emitting that as a 2-together buy would be wrong, so the row's seat order
 * comes from the venue manifest and adjacency is checked against it.
 */
function rowSeatOrder(venue: Venue): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const s of venue.sections) {
    const rows = new Map<string, Array<{ seat: string; x: number; y: number }>>()
    for (const st of s.seats) {
      const arr = rows.get(st.row) ?? []
      arr.push({ seat: st.seat, x: st.x, y: st.y })
      rows.set(st.row, arr)
    }
    for (const [row, arr] of rows) {
      // Rows run along whichever axis they span — sort along that one.
      const xs = arr.map((a) => a.x)
      const ys = arr.map((a) => a.y)
      const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)
      arr.sort((p, q) => (alongX ? p.x - q.x : p.y - q.y))
      out.set(`${s.sectionId}|${row}`, arr.map((a) => a.seat))
    }
  }
  return out
}

/** True when two of `seats` sit at consecutive positions in the row. */
function hasAdjacentPair(order: Map<string, string[]>, key: string, seats: string[]): boolean {
  const seq = order.get(key)
  if (!seq) return false
  const idx = seats
    .map((s) => seq.indexOf(s))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  for (let i = 1; i < idx.length; i++) if (idx[i] - idx[i - 1] === 1) return true
  return false
}

export async function capture(): Promise<Listing[]> {
  const raw: Raw = existsSync(RAW)
    ? JSON.parse(readFileSync(RAW, 'utf8'))
    : await fetchRaw()

  if (!raw.facets?.length) {
    throw new Error(
      `${RAW} has no place-bearing facets — re-run a live capture (delete the file) ` +
        'or the offer->section join cannot be made',
    )
  }

  // placeId -> seat, from the venue manifest. Ticketmaster's place ids are the
  // manifest's seat ids, which is what makes exact seat resolution possible.
  const venue: Venue = JSON.parse(readFileSync(VENUE, 'utf8'))
  const byPlace = new Map<string, { section: string; row: string; seat: string }>()
  for (const s of venue.sections) {
    for (const st of s.seats) {
      byPlace.set(st.seatId, { section: s.sectionId, row: st.row, seat: st.seat })
    }
  }
  const seatOrder = rowSeatOrder(venue)

  // Rule 5: the emitted section must be a venue-vocab id, or the map can't
  // place it. Anything else is reported rather than emitted.
  const vocab = new Set<string>(
    (JSON.parse(readFileSync(VOCAB, 'utf8')) as { sectionIds: string[] }).sectionIds,
  )

  const offerById = new Map(raw.offers.map((o) => [o.offerId, o]))
  const listings: Listing[] = []
  const emitted = new Set<string>()
  const dropped = {
    noPrice: 0,
    notPairable: 0,
    tooFewPlaces: 0,
    unresolved: 0,
    noAdjacentPair: 0,
    offVocab: 0,
  }
  const offVocabLabels = new Set<string>()

  for (const facet of raw.facets) {
    if (facet.available === false) continue
    const facetSection = normalizeSection(facet.section)

    for (const offerId of facet.offers ?? []) {
      const offer = offerById.get(offerId)
      if (!offer) {
        // The two responses were captured moments apart; inventory can move
        // between them. Counted, not guessed at.
        dropped.noPrice++
        continue
      }
      if (!(offer.sellableQuantities ?? []).includes(QUANTITY)) {
        dropped.notPairable++
        continue
      }

      const placeIds = expandAll(facet.places)
      const seats = placeIds
        .map((id) => byPlace.get(id))
        .filter((s): s is { section: string; row: string; seat: string } => !!s)
      if (seats.length !== placeIds.length) dropped.unresolved++
      if (seats.length < QUANTITY) {
        // sellableQuantities says 2 is orderable for the price level, but this
        // facet has fewer than 2 seats left — not actually a 2-together buy.
        dropped.tooFewPlaces++
        continue
      }

      const allIn = allInPerTicket(offer)
      if (!(allIn > 0)) continue

      // A price-level offer can span rows (and, in principle, sections). Two
      // tickets together means two seats in the SAME row, so group by the
      // section+row the seats actually resolved to and emit one listing each.
      const byRow = new Map<string, string[]>()
      for (const s of seats) {
        const key = `${s.section}|${s.row}`
        const arr = byRow.get(key) ?? []
        arr.push(s.seat)
        byRow.set(key, arr)
      }

      for (const [key, seatNos] of byRow) {
        if (seatNos.length < QUANTITY) continue
        // Rule 3: two seats in one row are only a pair if they are next to each
        // other. Scattered singles at the same price level are not a 2-together
        // buy, so they are dropped rather than emitted as one.
        if (!hasAdjacentPair(seatOrder, key, seatNos)) {
          dropped.noAdjacentPair++
          continue
        }
        seatNos.sort((a, b) => Number(a) - Number(b))
        const [placedSection, row] = key.split('|')
        // Resale offers are a single contiguous block, so the offer's own
        // section/row are authoritative where present.
        const section = normalizeSection(offer.section ?? placedSection ?? facetSection)
        if (!vocab.has(section)) {
          dropped.offVocab++
          offVocabLabels.add(offer.section ?? facet.section ?? '(absent)')
          continue
        }
        listings.push({
          source: 'ticketmaster',
          section,
          row: normalizeRow(offer.row ?? row),
          seats: seatNos,
          allInPricePerTicket: allIn,
          // Resale offers have a stable listing id; primary offers are price
          // levels, so the id is scoped by the section/row it resolved to.
          sourceListingId: offer.listingId
            ? offer.listingId
            : `${offer.offerId}:${placedSection}:${row}`,
          listingUrl: EVENT_URL,
          capturedAt: raw.capturedAt,
        })
        emitted.add(offer.offerId)
      }
    }
  }

  const summary = Object.entries(dropped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  if (summary) console.log(`[ticketmaster] dropped: ${summary}`)
  if (dropped.offVocab > 0) {
    console.warn(
      `[ticketmaster] ${dropped.offVocab} row(s) dropped for a section absent from ` +
        `venue-vocab.json: ${[...offVocabLabels].join(', ')}`,
    )
  }
  // Rule 3 cuts both ways: an offer the facets response never mentioned can't be
  // placed, and silence about it would look like it doesn't exist.
  const unplaced = raw.offers.filter(
    (o) => (o.sellableQuantities ?? []).includes(QUANTITY) && !emitted.has(o.offerId),
  )
  if (unplaced.length > 0) {
    console.warn(
      `[ticketmaster] ${unplaced.length} of ${
        raw.offers.filter((o) => (o.sellableQuantities ?? []).includes(QUANTITY)).length
      } pair-buyable offer(s) produced no listing (no place data in the facets ` +
        `snapshot, or no adjacent pair left): ${unplaced.map((o) => o.offerId).join(', ')}`,
    )
  }
  console.log(`[ticketmaster] ${listings.length} listings at qty ${QUANTITY}`)

  return listings
}
