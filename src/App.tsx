import { useMemo, useState } from 'react'
import type { CaptureBundle, Listing, SourceStatus, Venue } from './types'
import { SOURCES } from './types'
import { SeatMap } from './components/SeatMap'
import { ListingPanel } from './components/ListingPanel'
import { Legend } from './components/Legend'
import {
  applyFilters,
  applySelection,
  buildMapModel,
  type Filters,
} from './lib/viewModel'
import { buildPriceScale } from './lib/priceScale'
import venueJson from './data/venue.json'
import fixtures from './data/fixtures.json'

const venue = venueJson as unknown as Venue

/**
 * The UI reads a static bundle. Phase 1 renders fixtures; once a capture has been
 * run, /captures/listings.json is served by Vite from the project root and takes
 * over. The parsers are never imported here — the same capture() functions can
 * later sit behind a local endpoint without touching this file.
 */
const bundle = await loadBundle()

async function loadBundle(): Promise<CaptureBundle> {
  try {
    const res = await fetch('/captures/listings.json')
    if (res.ok) {
      const b = (await res.json()) as CaptureBundle
      if (Array.isArray(b.listings) && b.listings.length) return b
    }
  } catch {
    // No capture run yet — fixtures are the expected state in Phase 1.
  }
  const listings = fixtures as Listing[]
  return {
    event: {
      name: "US Open Women's Singles Semifinals",
      venue: 'Arthur Ashe Stadium',
      startsAt: '2026-09-10T19:00:00-04:00',
      quantity: 2,
    },
    generatedAt: listings[0]?.capturedAt ?? '',
    sources: SOURCES.map(
      (source): SourceStatus => ({
        source,
        status: 'ok',
        capturedAt: listings.find((l) => l.source === source)?.capturedAt ?? '',
        listingCount: listings.filter((l) => l.source === source).length,
        method: 'manual-file',
      }),
    ),
    listings,
  }
}

export default function App() {
  const all = bundle.listings
  const bounds = useMemo(() => {
    const p = all.map((l) => l.allInPricePerTicket)
    return { min: Math.floor(Math.min(...p)), max: Math.ceil(Math.max(...p)) }
  }, [all])

  const [filters, setFilters] = useState<Filters>({
    priceMin: bounds.min,
    priceMax: bounds.max,
    sources: new Set(SOURCES),
    selection: null,
  })

  // The map shows everything passing the price/source filters; the panel
  // additionally narrows to the map selection. Otherwise clicking a section
  // would erase the rest of the map.
  const filtered = useMemo(() => applyFilters(all, filters), [all, filters])
  const panelListings = useMemo(
    () =>
      applySelection(filtered, filters, venue).sort(
        (a, b) => a.allInPricePerTicket - b.allInPricePerTicket,
      ),
    [filtered, filters],
  )

  const model = useMemo(() => buildMapModel(venue, filtered), [filtered])
  // Scale is built from the unfiltered set so colors don't shift as you filter.
  const scale = useMemo(
    () => buildPriceScale(all.map((l) => l.allInPricePerTicket)),
    [all],
  )

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex shrink-0 items-center gap-4 border-b border-neutral-200 px-5 py-2.5">
        <div>
          <h1 className="text-[15px] font-bold leading-tight text-neutral-900">
            {bundle.event.name}
          </h1>
          <p className="text-[11px] text-neutral-500">
            {bundle.event.venue} · Thu Sep 10, 2026 · 7:00 PM ·{' '}
            <span className="font-medium text-neutral-700">2 tickets together</span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4 text-[11px] text-neutral-500">
          <span>
            <span className="font-semibold tabular-nums text-neutral-900">
              {model.pricedSeats.size.toLocaleString()}
            </span>{' '}
            seats priced
          </span>
          <span>
            <span className="font-semibold tabular-nums text-neutral-900">
              {model.tintedSections.size}
            </span>{' '}
            sections tinted
          </span>
          <span>
            <span className="font-semibold tabular-nums text-neutral-900">
              {venue.totalSeats.toLocaleString()}
            </span>{' '}
            manifest seats
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <SeatMap
            venue={venue}
            model={model}
            scale={scale}
            filters={filters}
            onSelect={(selection) => setFilters((f) => ({ ...f, selection }))}
          />
          <Legend scale={scale} />
          {model.unplaceable.length > 0 && (
            <div className="absolute bottom-4 right-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[10px] text-amber-900 shadow">
              {model.unplaceable.length} listing
              {model.unplaceable.length === 1 ? '' : 's'} could not be placed on
              the map
            </div>
          )}
        </div>
        <ListingPanel
          listings={panelListings}
          totalCount={all.length}
          filters={filters}
          bounds={bounds}
          scale={scale}
          statuses={bundle.sources}
          onFilters={setFilters}
          onClearSelection={() => setFilters((f) => ({ ...f, selection: null }))}
        />
      </main>
    </div>
  )
}
