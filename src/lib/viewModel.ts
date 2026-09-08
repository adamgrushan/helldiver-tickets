/**
 * Derives everything the map and panel render from (venue, listings, filters).
 *
 * The important distinction this layer enforces: a listing that publishes seat
 * numbers can be drawn on the exact seats it covers, and a listing that doesn't
 * can only color its whole section. Those two are never mixed — a seat dot is
 * only ever colored by a listing that actually named that seat.
 */
import type { Listing, Source, Venue, VenueSeat } from '../types'

export type Filters = {
  priceMin: number
  priceMax: number
  sources: Set<Source>
  /** Map click narrows the panel to one section, or one seat within it. */
  selection: { sectionId: string; seatId?: string } | null
}

/** A seat that at least one seat-level listing covers. */
export type PricedSeat = {
  seat: VenueSeat
  sectionId: string
  /** Cheapest listing covering this exact seat. */
  cheapest: Listing
  /** All listings covering this exact seat, cheapest first. */
  listings: Listing[]
}

/** A section priced only by listings that don't publish seat numbers. */
export type TintedSection = {
  sectionId: string
  cheapest: Listing
  listings: Listing[]
}

export type MapModel = {
  /** seatId -> priced seat, for seat-level listings only. */
  pricedSeats: Map<string, PricedSeat>
  /** sectionId -> tint, for section-level (seats: null) listings only. */
  tintedSections: Map<string, TintedSection>
  /** Every price in the filtered set, for the color scale. */
  prices: number[]
}

const cheaper = (a: Listing, b: Listing) =>
  a.allInPricePerTicket - b.allInPricePerTicket

export function applyFilters(listings: Listing[], f: Filters): Listing[] {
  return listings.filter((l) => {
    if (!f.sources.has(l.source)) return false
    if (l.allInPricePerTicket < f.priceMin) return false
    if (l.allInPricePerTicket > f.priceMax) return false
    return true
  })
}

/** Narrow to the map selection. Applied to the panel, not to the map itself. */
export function applySelection(listings: Listing[], f: Filters, venue: Venue): Listing[] {
  const sel = f.selection
  if (!sel) return listings
  const inSection = listings.filter((l) => l.section === sel.sectionId)
  if (!sel.seatId) return inSection

  const seat = venue.sections
    .find((s) => s.sectionId === sel.sectionId)
    ?.seats.find((s) => s.seatId === sel.seatId)
  if (!seat) return inSection

  // Clicking a seat shows listings that name that seat, plus the section-level
  // listings that could include it — the latter genuinely might be that seat.
  return inSection.filter(
    (l) =>
      l.seats === null ||
      (l.row === seat.row && l.seats.includes(seat.seat)),
  )
}

/**
 * Build the map model from already-filtered listings.
 *
 * Listings whose (section, row, seat) can't be resolved against the manifest are
 * counted as unplaceable rather than guessed at — they still appear in the panel.
 */
export function buildMapModel(
  venue: Venue,
  listings: Listing[],
): MapModel & { unplaceable: Listing[] } {
  // (sectionId, row, seat) -> seat, for resolving seat-level listings.
  const seatIndex = new Map<string, VenueSeat>()
  for (const s of venue.sections) {
    for (const seat of s.seats) {
      seatIndex.set(`${s.sectionId}|${seat.row}|${seat.seat}`, seat)
    }
  }
  const sectionIds = new Set(venue.sections.map((s) => s.sectionId))

  const pricedSeats = new Map<string, PricedSeat>()
  const tintedSections = new Map<string, TintedSection>()
  const unplaceable: Listing[] = []

  for (const l of listings) {
    if (!sectionIds.has(l.section)) {
      unplaceable.push(l)
      continue
    }

    if (l.seats === null) {
      // Section-level: tint the whole section by its cheapest such listing.
      const existing = tintedSections.get(l.section)
      if (existing) {
        existing.listings.push(l)
        if (cheaper(l, existing.cheapest) < 0) existing.cheapest = l
      } else {
        tintedSections.set(l.section, {
          sectionId: l.section,
          cheapest: l,
          listings: [l],
        })
      }
      continue
    }

    // Seat-level: color only the seats this listing actually names.
    let placedAny = false
    for (const seatNo of l.seats) {
      const seat = seatIndex.get(`${l.section}|${l.row ?? ''}|${seatNo}`)
      if (!seat) continue
      placedAny = true
      const existing = pricedSeats.get(seat.seatId)
      if (existing) {
        existing.listings.push(l)
        if (cheaper(l, existing.cheapest) < 0) existing.cheapest = l
      } else {
        pricedSeats.set(seat.seatId, {
          seat,
          sectionId: l.section,
          cheapest: l,
          listings: [l],
        })
      }
    }
    if (!placedAny) unplaceable.push(l)
  }

  for (const ps of pricedSeats.values()) ps.listings.sort(cheaper)
  for (const ts of tintedSections.values()) ts.listings.sort(cheaper)

  const prices = listings.map((l) => l.allInPricePerTicket)
  return { pricedSeats, tintedSections, prices, unplaceable }
}

export const SOURCE_LABELS: Record<Source, string> = {
  ticketmaster: 'Ticketmaster',
  stubhub: 'StubHub',
  seatgeek: 'SeatGeek',
  ticketliquidator: 'Ticket Liquidator',
  vividseats: 'Vivid Seats',
}

/** Distinguishable badge colors, independent of the price scale. */
export const SOURCE_BADGE: Record<Source, string> = {
  ticketmaster: 'bg-[#026cdf] text-white',
  stubhub: 'bg-[#3f1d75] text-white',
  seatgeek: 'bg-[#ff5b49] text-white',
  ticketliquidator: 'bg-[#0b6b3a] text-white',
  vividseats: 'bg-[#f8485e] text-white',
}

/** "Sec 116 • Row Q • Seats 5-6", with the seats clause omitted when null. */
export function describeListing(l: Listing): string {
  const parts = [`Sec ${l.section}`]
  if (l.row) parts.push(`Row ${l.row}`)
  if (l.seats && l.seats.length) {
    const nums = l.seats.map(Number)
    const contiguous =
      nums.every(Number.isFinite) &&
      nums.every((n, i) => i === 0 || n === nums[i - 1] + 1)
    parts.push(
      l.seats.length > 1 && contiguous
        ? `Seats ${l.seats[0]}-${l.seats[l.seats.length - 1]}`
        : `Seat${l.seats.length > 1 ? 's' : ''} ${l.seats.join(', ')}`,
    )
  }
  return parts.join(' • ')
}
