/**
 * Collapse the same physical inventory listed on more than one site.
 *
 * Ticket Liquidator and Vivid Seats both syndicate broker inventory, so the same
 * pair of seats routinely appears on both at near-identical all-in prices. Left
 * alone it double-counts the market and puts two rows in the panel for one buy.
 *
 * Match rule: same section, same row, all-in price within PRICE_TOLERANCE.
 * The surviving listing keeps the LOWEST all-in price and records every source
 * that carried it in `alsoOn`.
 *
 * Seat numbers are a veto, not part of the key: if two listings both publish
 * seat numbers and those differ, they are different seats and are never
 * collapsed, however close the price. That keeps seat-level inventory (which
 * Ticketmaster publishes in full) from being thrown away by a price coincidence.
 */
import type { Listing, Source } from '../../src/types.ts'

export const PRICE_TOLERANCE = 0.02

const key = (l: Listing) => `${l.section}|${l.row ?? ''}`
const seatKey = (l: Listing) =>
  l.seats ? [...l.seats].sort((a, b) => Number(a) - Number(b)).join(',') : null

/** True when the two listings could be the same physical inventory. */
function couldBeSame(a: Listing, b: Listing): boolean {
  const sa = seatKey(a)
  const sb = seatKey(b)
  // Both name their seats and they disagree -> definitively different seats.
  if (sa !== null && sb !== null && sa !== sb) return false
  const lo = Math.min(a.allInPricePerTicket, b.allInPricePerTicket)
  if (lo <= 0) return false
  return Math.abs(a.allInPricePerTicket - b.allInPricePerTicket) / lo <= PRICE_TOLERANCE
}

export type DedupeResult = {
  listings: Listing[]
  /** How many listings were absorbed into a cheaper duplicate. */
  collapsed: number
  /** Cross-source collapses, for reporting. */
  pairs: Array<{ kept: Source; absorbed: Source; section: string; row: string | null }>
}

export function dedupe(listings: Listing[]): DedupeResult {
  const buckets = new Map<string, Listing[]>()
  for (const l of listings) {
    const arr = buckets.get(key(l)) ?? []
    arr.push(l)
    buckets.set(key(l), arr)
  }

  const out: Listing[] = []
  const pairs: DedupeResult['pairs'] = []
  let collapsed = 0

  for (const group of buckets.values()) {
    // Cheapest first, so the survivor of each cluster is always the lowest
    // all-in price and the greedy pass is deterministic.
    const sorted = [...group].sort(
      (a, b) => a.allInPricePerTicket - b.allInPricePerTicket,
    )
    const taken = new Set<number>()

    for (let i = 0; i < sorted.length; i++) {
      if (taken.has(i)) continue
      const keep = sorted[i]
      const sources = new Set<Source>([keep.source])

      for (let j = i + 1; j < sorted.length; j++) {
        if (taken.has(j)) continue
        if (!couldBeSame(keep, sorted[j])) continue
        taken.add(j)
        collapsed++
        sources.add(sorted[j].source)
        pairs.push({
          kept: keep.source,
          absorbed: sorted[j].source,
          section: keep.section,
          row: keep.row,
        })
      }

      out.push(
        sources.size > 1
          ? { ...keep, alsoOn: [...sources] }
          : keep,
      )
    }
  }

  out.sort((a, b) => a.allInPricePerTicket - b.allInPricePerTicket)
  return { listings: out, collapsed, pairs }
}
