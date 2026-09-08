/**
 * Phase 0 adapter: Ticketmaster map manifest -> the venue model the UI renders.
 *
 * Inputs (captured in Phase 0, see manifest/README.md):
 *   manifest/tm-placeDetailNoKeys.json  per-section SVG paths + per-seat x/y
 *   manifest/tm-venue-map.svg           background art, same coordinate space
 *
 * Output: src/data/venue.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { normalizeSection } from '../capture/lib/normalize.ts'
import type { Venue, VenueSection, VenueSeat } from '../src/types.ts'

const GEOMETRY = 'manifest/tm-placeDetailNoKeys.json'
const BACKGROUND = 'manifest/tm-venue-map.svg'
const OUT = 'src/data/venue.json'

/**
 * placesNoKeys is a positional tuple, not an object:
 *   [placeId, seatLabel, x, y, gridBand, colIndex, rowIndex]
 * Only the first four are load-bearing here.
 */
type PlaceTuple = [string, string, number, number, string, number, number]

type Segment = {
  id: string
  name: string
  segmentCategory: 'COMPOSITE' | 'SECTION' | 'ROW'
  segments?: Segment[]
  shapes?: Array<{
    path: string
    labels?: Array<{ text: string; x: number; y: number }>
  }>
  placesNoKeys?: PlaceTuple[]
  totalPlaces?: number
}

/** Walk a section subtree collecting every ROW's places. */
function collectSeats(seg: Segment, out: VenueSeat[], row: string | null): void {
  const rowLabel = seg.segmentCategory === 'ROW' ? seg.name : row
  for (const p of seg.placesNoKeys ?? []) {
    const [seatId, seat, x, y] = p
    out.push({ seatId, row: rowLabel ?? '', seat, x, y })
  }
  for (const child of seg.segments ?? []) collectSeats(child, out, rowLabel)
}

function build(): Venue {
  const geo = JSON.parse(readFileSync(GEOMETRY, 'utf8'))
  const page = geo.pages[0]
  const backgroundSvg = readFileSync(BACKGROUND, 'utf8')

  const sections: VenueSection[] = []
  const seenIds = new Set<string>()

  for (const seg of page.segments as Segment[]) {
    const shape = seg.shapes?.[0]
    if (!shape?.path) {
      console.warn(`  skip "${seg.name}": no shape path`)
      continue
    }

    const sectionId = normalizeSection(seg.name)
    if (seenIds.has(sectionId)) {
      // Two manifest segments folding to one id would silently merge seats.
      throw new Error(`duplicate sectionId "${sectionId}" from "${seg.name}"`)
    }
    seenIds.add(sectionId)

    const seats: VenueSeat[] = []
    collectSeats(seg, seats, null)

    const label = shape.labels?.[0]
    sections.push({
      sectionId,
      polygon: shape.path,
      label: seg.name,
      labelX: label?.x ?? 0,
      labelY: label?.y ?? 0,
      seats,
    })
  }

  const totalSeats = sections.reduce((n, s) => n + s.seats.length, 0)
  if (totalSeats !== geo.totalPlaces) {
    console.warn(
      `  seat count ${totalSeats} != manifest totalPlaces ${geo.totalPlaces}`,
    )
  }

  return {
    venueConfigId: String(geo.venueConfigId),
    width: page.width,
    height: page.height,
    backgroundSvg,
    sections,
    totalSeats,
  }
}

const venue = build()
mkdirSync('src/data', { recursive: true })
writeFileSync(OUT, JSON.stringify(venue))
console.log(
  `${OUT}: ${venue.sections.length} sections, ${venue.totalSeats} seats, ` +
    `${venue.width}x${venue.height}`,
)
const empty = venue.sections.filter((s) => s.seats.length === 0)
if (empty.length) {
  console.log(`  ${empty.length} sections have no seats: ${empty.map((s) => s.sectionId).join(', ')}`)
}
