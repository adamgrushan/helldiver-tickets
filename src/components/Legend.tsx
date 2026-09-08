import type { PriceScale } from '../lib/priceScale'
import { moneyShort } from '../lib/priceScale'

/**
 * The legend has to explain two encodings, not one: dot color for seat-level
 * listings, and hatch for sections priced by a listing with no seat numbers.
 */
export function Legend({ scale }: { scale: PriceScale }) {
  if (!scale.bands.length) return null
  return (
    <div className="absolute bottom-4 left-4 rounded-lg border border-neutral-200 bg-white/95 p-3 shadow-lg backdrop-blur">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        All-in price per ticket
      </div>
      <div className="flex items-end gap-0">
        {scale.bands.map((b, i) => (
          <div key={b.color} className="flex flex-col items-start">
            <div className="h-3 w-14" style={{ background: b.color }} />
            <div className="mt-1 text-[9px] tabular-nums text-neutral-600">
              {i === 0 ? moneyShort(b.min) : moneyShort(b.min)}
            </div>
          </div>
        ))}
        <div className="flex flex-col items-start">
          <div className="h-3 w-0" />
          <div className="mt-1 pl-1 text-[9px] tabular-nums text-neutral-600">
            {moneyShort(scale.max)}
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-neutral-200 pt-2.5">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" className="shrink-0">
            <circle cx="8" cy="8" r="5" fill={scale.bands[2]?.color ?? '#059669'} stroke="#fff" strokeWidth="1.2" />
          </svg>
          <span className="text-[10px] text-neutral-600">
            Seat priced — exact seats published
          </span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="16" height="16" className="shrink-0">
            <defs>
              <pattern id="legendHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="4" stroke={scale.bands[2]?.color ?? '#059669'} strokeWidth="0.9" />
              </pattern>
            </defs>
            <rect x="1" y="3" width="14" height="10" fill="url(#legendHatch)" stroke="#d8d8dd" strokeWidth="0.8" />
          </svg>
          <span className="text-[10px] text-neutral-600">
            Section priced — no seat numbers
          </span>
        </div>
        <div className="flex items-center gap-2">
          <svg width="16" height="16" className="shrink-0">
            <circle cx="8" cy="8" r="3.2" fill="#c9c9d0" />
          </svg>
          <span className="text-[10px] text-neutral-600">
            No 2-together listing
          </span>
        </div>
      </div>
    </div>
  )
}
