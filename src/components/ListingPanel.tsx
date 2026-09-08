import type { Listing, Source, SourceStatus } from '../types'
import { SOURCES } from '../types'
import type { Filters } from '../lib/viewModel'
import { describeListing, SOURCE_BADGE, SOURCE_LABELS } from '../lib/viewModel'
import { money, moneyShort } from '../lib/priceScale'
import type { PriceScale } from '../lib/priceScale'

type Props = {
  listings: Listing[]
  totalCount: number
  filters: Filters
  bounds: { min: number; max: number }
  scale: PriceScale
  statuses: SourceStatus[]
  onFilters: (f: Filters) => void
  onClearSelection: () => void
}

export function ListingPanel({
  listings,
  totalCount,
  filters,
  bounds,
  scale,
  statuses,
  onFilters,
  onClearSelection,
}: Props) {
  const toggleSource = (s: Source) => {
    const next = new Set(filters.sources)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    onFilters({ ...filters, sources: next })
  }

  return (
    <aside className="flex h-full w-[420px] shrink-0 flex-col border-l border-neutral-200 bg-white">
      <header className="border-b border-neutral-200 px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">2 Tickets Together</h2>
          <span className="text-xs tabular-nums text-neutral-500">
            {listings.length}
            {listings.length !== totalCount && ` of ${totalCount}`} listings
          </span>
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          All-in prices — fees included, before tax.
        </p>
      </header>

      <Filtering
        filters={filters}
        bounds={bounds}
        onFilters={onFilters}
        toggleSource={toggleSource}
      />

      {filters.selection && (
        <div className="flex items-center justify-between border-b border-blue-100 bg-blue-50 px-4 py-2">
          <span className="text-xs font-medium text-blue-900">
            Filtered to Sec {filters.selection.sectionId}
            {filters.selection.seatId && ' • one seat'}
          </span>
          <button
            onClick={onClearSelection}
            className="text-xs font-medium text-blue-700 hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listings.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-neutral-500">
            No listings match these filters.
          </p>
        ) : (
          <ul>
            {listings.map((l) => (
              <ListingRow key={`${l.source}-${l.sourceListingId}`} listing={l} scale={scale} />
            ))}
          </ul>
        )}
      </div>

      <SourceStatusLines statuses={statuses} />
    </aside>
  )
}

function ListingRow({ listing: l, scale }: { listing: Listing; scale: PriceScale }) {
  return (
    <li className="border-b border-neutral-100 last:border-0">
      <a
        href={l.listingUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
      >
        {/* Price-scale swatch ties each row back to its dot on the map. */}
        <span
          className="h-9 w-1.5 shrink-0 rounded-full"
          style={{ background: scale.color(l.allInPricePerTicket) }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${SOURCE_BADGE[l.source]}`}
            >
              {SOURCE_LABELS[l.source]}
            </span>
            {l.alsoOn && l.alsoOn.length > 1 && (
              <span
                className="rounded bg-neutral-100 px-1.5 py-0.5 text-[9px] font-medium text-neutral-600"
                title={`Also listed on ${l.alsoOn
                  .filter((s) => s !== l.source)
                  .map((s) => SOURCE_LABELS[s])
                  .join(', ')}`}
              >
                +{l.alsoOn.length - 1} more
              </span>
            )}
            {l.seats === null && (
              <span
                className="text-[9px] font-medium uppercase tracking-wide text-neutral-400"
                title="This source doesn't publish seat numbers for this listing"
              >
                no seat #
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-[13px] font-medium text-neutral-900">
            {describeListing(l)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[15px] font-bold tabular-nums text-[#026cdf]">
            {money(l.allInPricePerTicket)}
          </div>
          <div className="text-[9px] text-neutral-400">each, all-in</div>
        </div>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="shrink-0 text-neutral-300"
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </a>
    </li>
  )
}

function Filtering({
  filters,
  bounds,
  onFilters,
  toggleSource,
}: {
  filters: Filters
  bounds: { min: number; max: number }
  onFilters: (f: Filters) => void
  toggleSource: (s: Source) => void
}) {
  return (
    <div className="space-y-3 border-b border-neutral-200 px-4 py-3">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Price range
          </label>
          <span className="text-[11px] font-medium tabular-nums text-neutral-700">
            {moneyShort(filters.priceMin)} – {moneyShort(filters.priceMax)}
          </span>
        </div>
        {/* Two thumbs over one track: min on top of max, so both stay grabbable. */}
        <div className="relative h-5">
          <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-neutral-200" />
          <div
            className="absolute top-2 h-1 rounded-full bg-[#026cdf]"
            style={{
              left: `${pct(filters.priceMin, bounds)}%`,
              right: `${100 - pct(filters.priceMax, bounds)}%`,
            }}
          />
          <input
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={filters.priceMin}
            onChange={(e) =>
              onFilters({
                ...filters,
                priceMin: Math.min(Number(e.target.value), filters.priceMax),
              })
            }
            className="range-thumb absolute inset-x-0 top-0 h-5 w-full"
          />
          <input
            type="range"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={filters.priceMax}
            onChange={(e) =>
              onFilters({
                ...filters,
                priceMax: Math.max(Number(e.target.value), filters.priceMin),
              })
            }
            className="range-thumb absolute inset-x-0 top-0 h-5 w-full"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
          Sources
        </label>
        <div className="flex flex-wrap gap-1.5">
          {SOURCES.map((s) => {
            const on = filters.sources.has(s)
            return (
              <button
                key={s}
                onClick={() => toggleSource(s)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  on
                    ? 'border-neutral-900 bg-neutral-900 text-white'
                    : 'border-neutral-300 bg-white text-neutral-500 hover:border-neutral-400'
                }`}
              >
                {SOURCE_LABELS[s]}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SourceStatusLines({ statuses }: { statuses: SourceStatus[] }) {
  return (
    <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-2.5">
      <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wide text-neutral-400">
        Source status
      </div>
      <ul className="space-y-1">
        {statuses.map((s) => (
          <li key={s.source} className="flex items-center gap-2 text-[10px]">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                s.status === 'ok' ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="w-24 shrink-0 font-medium text-neutral-700">
              {SOURCE_LABELS[s.source]}
            </span>
            <span
              className={s.status === 'ok' ? 'text-neutral-500' : 'text-red-600'}
              title={s.error}
            >
              {s.status === 'ok' ? `ok · ${s.listingCount}` : 'failed'}
            </span>
            <span className="ml-auto shrink-0 tabular-nums text-neutral-400">
              {relTime(s.capturedAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const pct = (v: number, b: { min: number; max: number }) =>
  b.max === b.min ? 0 : ((v - b.min) / (b.max - b.min)) * 100

function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}
