// Shared vocabulary between the capture scripts (Node) and the UI (browser).
// Nothing here may import from either side — keep it dependency-free.

export const SOURCES = [
  'ticketmaster',
  'stubhub',
  'seatgeek',
  'ticketliquidator',
  'vividseats',
] as const

export type Source = (typeof SOURCES)[number]

/**
 * One purchasable resale/primary offer, already filtered to "buyable as exactly
 * 2 tickets together".
 *
 * `allInPricePerTicket` is per-ticket, fees included, BEFORE tax. It is the only
 * price in the system — pre-fee prices never leave a source adapter.
 */
export type Listing = {
  source: Source
  sourceListingId: string
  /** Normalized to a venue manifest sectionId (see normalizeSection). */
  section: string
  row: string | null
  /** null where the source doesn't publish seat numbers. */
  seats: string[] | null
  allInPricePerTicket: number
  listingUrl: string
  capturedAt: string
  /**
   * Set by the dedupe pass when the same physical inventory was carried by more
   * than one source. Always includes `source`. Absent for un-deduped listings.
   */
  alsoOn?: Source[]
}

/** A seat with a known position in the venue's coordinate space. */
export type VenueSeat = {
  seatId: string
  row: string
  seat: string
  x: number
  y: number
}

export type VenueSection = {
  /** Canonical id: whitespace-stripped, uppercased (e.g. "100B", "318"). */
  sectionId: string
  /** SVG path string for the section outline, in venue coordinate space. */
  polygon: string
  /** Human-readable label as printed on the ticket (e.g. "100 B", "318"). */
  label: string
  /** Label anchor point, from the manifest's own label placement. */
  labelX: number
  labelY: number
  seats: VenueSeat[]
}

export type Venue = {
  venueConfigId: string
  /** Venue coordinate space; the background SVG uses the same viewBox. */
  width: number
  height: number
  /** Background venue art (court, structure, masks), inlined at build time. */
  backgroundSvg: string
  sections: VenueSection[]
  totalSeats: number
}

/** Per-source outcome, surfaced in the UI's status line. */
export type SourceStatus = {
  source: Source
  status: 'ok' | 'failed'
  /** ISO timestamp of the capture attempt. */
  capturedAt: string
  listingCount: number
  /** How the data was obtained, for provenance in the UI. */
  method: 'api' | 'dom' | 'manual-file'
  error?: string
}

export type CaptureBundle = {
  event: {
    name: string
    venue: string
    startsAt: string
    quantity: 2
  }
  generatedAt: string
  sources: SourceStatus[]
  listings: Listing[]
}

/** Every source adapter implements exactly this. */
export type CaptureFn = () => Promise<Listing[]>
