/**
 * Phase 1 fixtures: ~40 listings for building the UI against, before any real
 * capture exists.
 *
 * Section / row / seat ids are drawn from the real venue manifest rather than
 * typed by hand, so every fixture places correctly on the map. The price spread,
 * source mix, and which listings carry seat numbers are authored below; the
 * selection is seeded, so re-running produces the identical file.
 *
 * Output: src/data/fixtures.json  (committed; the UI imports it directly)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { Listing, Source, Venue } from '../src/types.ts'

const venue: Venue = JSON.parse(readFileSync('src/data/venue.json', 'utf8'))
const byId = new Map(venue.sections.map((s) => [s.sectionId, s]))

/** Deterministic PRNG so the committed fixture file is stable. */
let seed = 20260910
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]

const EVENT_URLS: Record<Source, string> = {
  ticketmaster:
    'https://www.ticketmaster.com/womens-singles-semifinals-flushing-new-york-09-10-2026/event/1D00646DB471672F',
  stubhub: 'https://www.stubhub.com/us-open-tennis-flushing-tickets-9-10-2026/event/159351469/?quantity=2',
  seatgeek: 'https://seatgeek.com/us-open-tennis-tickets/tennis/2026-09-10-7-pm/17807645?quantity=2',
  ticketliquidator:
    'https://www.ticketliquidator.com/tickets/7396871/2026-us-open-tennis-championships-session-23-tickets-thu-sep-10-2026-arthur-ashe-stadium',
  vividseats:
    'https://www.vividseats.com/us-open-tennis-tickets-arthur-ashe-stadium-9-10-2026--sports-tennis/production/5990417?quantity=2',
}

/**
 * Authored spread: [sectionId, source, allInPricePerTicket, withSeats].
 * Courtside 100s run expensive, promenade 300s cheap — mirroring the real event.
 * Roughly half carry seat numbers; the rest exercise the section-tint path.
 */
const SPEC: Array<[string, Source, number, boolean]> = [
  // Courtside / lower bowl — premium
  ['100A', 'ticketmaster', 3480.0, true],
  ['100C', 'vividseats', 2965.5, false],
  ['100E', 'stubhub', 2740.25, true],
  ['101', 'seatgeek', 2210.0, false],
  ['104', 'ticketmaster', 1985.4, true],
  ['110', 'ticketmaster', 1409.0, true],
  ['116', 'ticketmaster', 1409.0, true],
  ['122', 'stubhub', 1352.75, false],
  ['108', 'vividseats', 1290.0, false],
  ['113', 'seatgeek', 1178.6, true],
  ['119', 'ticketliquidator', 1104.0, false],
  ['124', 'vividseats', 1050.5, true],
  // Loge 200s — mid
  ['203', 'stubhub', 928.0, false],
  ['209', 'seatgeek', 874.25, true],
  ['215', 'ticketmaster', 812.0, true],
  ['221', 'vividseats', 780.9, false],
  ['227', 'ticketliquidator', 731.5, false],
  ['206', 'stubhub', 698.0, true],
  ['212', 'seatgeek', 655.75, false],
  ['218', 'ticketmaster', 623.0, true],
  ['224', 'vividseats', 594.4, false],
  ['230', 'ticketliquidator', 561.0, false],
  ['201', 'stubhub', 534.8, true],
  ['232', 'seatgeek', 508.25, true],
  // Promenade 300s — value
  ['305', 'ticketmaster', 470.0, true],
  ['311', 'vividseats', 441.6, false],
  ['317', 'stubhub', 415.0, true],
  ['323', 'seatgeek', 391.25, true],
  ['329', 'ticketliquidator', 368.0, false],
  ['335', 'vividseats', 349.9, false],
  ['302', 'ticketmaster', 331.5, true],
  ['308', 'stubhub', 316.0, false],
  ['314', 'seatgeek', 302.75, true],
  ['320', 'ticketliquidator', 291.25, false],
  ['326', 'vividseats', 288.92, false],
  ['332', 'stubhub', 284.5, true],
  ['338', 'seatgeek', 281.0, false],
  ['318', 'ticketmaster', 279.6, true],
  ['307', 'ticketliquidator', 276.4, false],
  ['340', 'vividseats', 272.0, false],
  // Deliberate near-duplicate pair across the two syndicating brokers, to
  // exercise the dedupe pass: same section/row, prices within ~2%.
  ['313', 'ticketliquidator', 358.0, false],
  ['313', 'vividseats', 353.2, false],
]

const CAPTURED_AT = '2026-09-07T17:40:00.000Z'
const listings: Listing[] = []
const counters: Record<string, number> = {}

for (const [sectionId, source, price, withSeats] of SPEC) {
  const section = byId.get(sectionId)
  if (!section) throw new Error(`fixture references unknown section ${sectionId}`)
  if (section.seats.length === 0) throw new Error(`section ${sectionId} has no seats`)

  const rows = [...new Set(section.seats.map((s) => s.row))]
  const row = pick(rows)
  const inRow = section.seats
    .filter((s) => s.row === row)
    .sort((a, b) => Number(a.seat) - Number(b.seat))

  let seats: string[] | null = null
  if (withSeats) {
    // Two genuinely adjacent seats that exist in the manifest.
    const i = Math.min(Math.floor(rnd() * (inRow.length - 1)), inRow.length - 2)
    seats = [inRow[i].seat, inRow[i + 1].seat]
  }

  counters[source] = (counters[source] ?? 0) + 1
  listings.push({
    source,
    sourceListingId: `fx-${source}-${String(counters[source]).padStart(3, '0')}`,
    section: sectionId,
    row,
    seats,
    allInPricePerTicket: price,
    listingUrl: EVENT_URLS[source],
    capturedAt: CAPTURED_AT,
  })
}

writeFileSync('src/data/fixtures.json', JSON.stringify(listings, null, 1))

const withSeats = listings.filter((l) => l.seats).length
console.log(`src/data/fixtures.json: ${listings.length} listings`)
console.log(`  with seats: ${withSeats} | seats null: ${listings.length - withSeats}`)
console.log(`  sources: ${JSON.stringify(counters)}`)
console.log(
  `  price range: $${Math.min(...listings.map((l) => l.allInPricePerTicket))} - $${Math.max(...listings.map((l) => l.allInPricePerTicket))}`,
)
