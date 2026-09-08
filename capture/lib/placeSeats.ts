/**
 * Cross-source seat validation.
 *
 * "Never place a dot for a seat number you don't have" has to hold for every
 * source, not just the well-behaved ones. Sources publish seat labels that
 * don't correspond to real seats — StubHub emits sentinel ranges like
 * `9996-9999`, and occasional rows carry seat numbers copied from the section
 * id. Passing those through would put dots on seats that don't exist, or worse,
 * on the wrong seats.
 *
 * The venue manifest is the authority: a listing keeps its seat numbers only if
 * every one of them resolves to a real seat in that section and row. Otherwise
 * the source effectively did not publish usable seat numbers, and the listing
 * becomes `seats: null` — which the map already handles correctly by tinting the
 * section instead.
 *
 * This runs centrally in the orchestrator so the invariant holds regardless of
 * which adapter produced the listing.
 */
import type { Listing, Venue } from '../../src/types.ts'

export type SeatCheckResult = {
  listings: Listing[]
  /** Listings whose seat numbers were discarded as unresolvable. */
  nulled: Array<{ source: string; section: string; row: string | null; seats: string[] }>
}

export function nullifyUnplaceableSeats(
  listings: Listing[],
  venue: Venue,
): SeatCheckResult {
  const index = new Set<string>()
  for (const s of venue.sections) {
    for (const st of s.seats) index.add(`${s.sectionId}|${st.row}|${st.seat}`)
  }

  const out: Listing[] = []
  const nulled: SeatCheckResult['nulled'] = []

  for (const l of listings) {
    if (l.seats === null || l.seats.length === 0) {
      out.push(l.seats === null ? l : { ...l, seats: null })
      continue
    }
    // Every seat must resolve. A partially-resolving range means the pair's
    // identity is wrong, not merely incomplete.
    const allResolve =
      l.row !== null && l.seats.every((n) => index.has(`${l.section}|${l.row}|${n}`))
    if (allResolve) {
      out.push(l)
    } else {
      nulled.push({ source: l.source, section: l.section, row: l.row, seats: l.seats })
      out.push({ ...l, seats: null })
    }
  }

  return { listings: out, nulled }
}
