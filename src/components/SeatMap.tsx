import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Listing, Venue } from '../types'
import type { Filters, MapModel } from '../lib/viewModel'
import { describeListing, SOURCE_LABELS } from '../lib/viewModel'
import { money } from '../lib/priceScale'
import type { PriceScale } from '../lib/priceScale'

type Hover =
  | { kind: 'seat'; x: number; y: number; listings: Listing[]; label: string }
  | { kind: 'section'; x: number; y: number; listings: Listing[]; label: string }
  | null

type Props = {
  venue: Venue
  model: MapModel
  scale: PriceScale
  filters: Filters
  onSelect: (sel: Filters['selection']) => void
}

const MIN_ZOOM = 1
const MAX_ZOOM = 14

/**
 * Mean spacing between adjacent seats in venue units, from the manifest's own
 * grid. Dot radius is expressed relative to this so dots fill the seat grid
 * without merging into a solid mass.
 */
const SEAT_PITCH = 24

/** Wrapper size in CSS pixels, tracked so radii can be sized on screen. */
function useElementSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [ref])
  return size
}

export function SeatMap({ venue, model, scale, filters, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // View is a rect in venue coordinate space; zoom/pan just moves this rect.
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hover, setHover] = useState<Hover>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const size = useElementSize(wrapRef)

  const vw = venue.width / zoom
  const vh = venue.height / zoom
  const maxX = venue.width - vw
  const maxY = venue.height - vh
  const vx = Math.min(Math.max(pan.x, 0), Math.max(maxX, 0))
  const vy = Math.min(Math.max(pan.y, 0), Math.max(maxY, 0))

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      setZoom((z) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor))
        if (next === z) return z
        // Keep the point under the cursor fixed while scaling.
        setPan((p) => {
          const w = venue.width / z
          const h = venue.height / z
          const nw = venue.width / next
          const nh = venue.height / next
          return {
            x: p.x + (cx / 100) * (w - nw),
            y: p.y + (cy / 100) * (h - nh),
          }
        })
        return next
      })
    },
    [venue.width, venue.height],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const r = wrapRef.current?.getBoundingClientRect()
      if (!r) return
      const cx = ((e.clientX - r.left) / r.width) * 100
      const cy = ((e.clientY - r.top) / r.height) * 100
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, cx, cy)
    },
    [zoomAt],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, px: vx, py: vy }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return
    // Convert screen delta to venue-space delta at the current zoom.
    setPan({
      x: d.px - ((e.clientX - d.x) / r.width) * vw,
      y: d.py - ((e.clientY - d.y) / r.height) * vh,
    })
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const reset = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Radii are authored in screen pixels and converted back to venue units, so a
  // dot keeps a usable size at every zoom level. Without this, radii fixed in
  // venue units fall below one device pixel at full-venue zoom and the seat
  // layer disappears.
  const scaleFit = size.w && size.h ? Math.min(size.w / vw, size.h / vh) : 0
  const pxToVenue = (px: number) => (scaleFit > 0 ? px / scaleFit : px)

  // Unpriced seats are negative information: they should read as texture at
  // full-venue zoom and resolve into distinct dots as you zoom in, without ever
  // competing with a priced dot.
  const greyR = clamp(pxToVenue(0.9), 6, SEAT_PITCH * 0.42)
  // Priced seats must stay findable among 21k seats, so they get a screen-size
  // floor — capped so they don't swallow their section when zoomed all the way
  // out.
  const pricedR = clamp(pxToVenue(3), SEAT_PITCH * 0.4, SEAT_PITCH * 1.25)
  const strokeW = pxToVenue(0.7)

  const sectionsWithTint = model.tintedSections
  const selected = filters.selection

  const tooltip = useMemo(() => {
    if (!hover) return null
    const cheapest = hover.listings[0]
    return { hover, cheapest }
  }, [hover])

  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      <div
        ref={wrapRef}
        className="h-full w-full cursor-grab active:cursor-grabbing touch-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          onPointerUp()
          setHover(null)
        }}
      >
        <svg
          viewBox={`${vx} ${vy} ${vw} ${vh}`}
          className="h-full w-full"
          preserveAspectRatio="xMidYMid meet"
        >
          <defs>
            {/* Section-level pricing (no seat numbers published) reads as a
                hatch, so it can never be mistaken for a seat-level dot. */}
            {/* Diagonal hatch marks a section priced by a listing with no seat
                numbers. Kept as thin lines rather than a heavy fill: with real
                inventory most sections carry at least one seatless listing, and
                a dense fill buries the seat-level dots that sit on top of it. */}
            <pattern
              id="hatch"
              width="56"
              height="56"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="56" height="56" fill="transparent" />
              <line x1="0" y1="0" x2="0" y2="56" stroke="currentColor" strokeWidth="11" />
            </pattern>
          </defs>

          {/* Venue art: structure, court, masks. Same coordinate space. */}
          <g
            dangerouslySetInnerHTML={{ __html: stripSvgWrapper(venue.backgroundSvg) }}
          />

          {/* Section outlines. */}
          {venue.sections.map((s) => {
            const tint = sectionsWithTint.get(s.sectionId)
            const isSel = selected?.sectionId === s.sectionId
            const color = tint ? scale.color(tint.cheapest.allInPricePerTicket) : null
            return (
              <g key={s.sectionId}>
                <path
                  d={s.polygon}
                  fill={color ?? '#f2f2f4'}
                  fillOpacity={color ? 0.13 : 0.5}
                  stroke={isSel ? '#111' : (color ?? '#d8d8dd')}
                  strokeWidth={isSel ? strokeW * 3 : strokeW}
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelect(isSel ? null : { sectionId: s.sectionId })
                  }}
                  onMouseEnter={() =>
                    setHover({
                      kind: 'section',
                      x: s.labelX,
                      y: s.labelY,
                      listings: tint?.listings ?? [],
                      label: `Section ${s.label}`,
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                />
                {/* Hatch layer, drawn only where a section-level listing set the
                    price. `color` drives the pattern via currentColor. */}
                {color && (
                  <path
                    d={s.polygon}
                    className="hatch-overlay pointer-events-none"
                    style={{ color }}
                    fillOpacity={0.5}
                  />
                )}
              </g>
            )
          })}

          {/* Seats. Grey unless a listing names that exact seat. Only rendered
              past a zoom threshold at full-venue scale would be 21k invisible
              dots — but they're cheap enough to always draw, and drawing them
              always keeps "no 2-together listing" legible. */}
          {venue.sections.map((s) => (
            <g key={`seats-${s.sectionId}`}>
              {s.seats.map((seat) => {
                const priced = model.pricedSeats.get(seat.seatId)
                const isSel = selected?.seatId === seat.seatId
                if (!priced) {
                  return (
                    <circle
                      key={seat.seatId}
                      cx={seat.x}
                      cy={seat.y}
                      r={greyR}
                      fill="#c2c2cc"
                      className="pointer-events-none"
                    />
                  )
                }
                return (
                  <circle
                    key={seat.seatId}
                    cx={seat.x}
                    cy={seat.y}
                    r={isSel ? pricedR * 1.6 : pricedR}
                    fill={scale.color(priced.cheapest.allInPricePerTicket)}
                    stroke={isSel ? '#111' : '#fff'}
                    strokeWidth={isSel ? strokeW * 2.5 : strokeW}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelect(
                        isSel
                          ? null
                          : { sectionId: s.sectionId, seatId: seat.seatId },
                      )
                    }}
                    onMouseEnter={() =>
                      setHover({
                        kind: 'seat',
                        x: seat.x,
                        y: seat.y,
                        listings: priced.listings,
                        label: `Sec ${s.label} • Row ${seat.row} • Seat ${seat.seat}`,
                      })
                    }
                    onMouseLeave={() => setHover(null)}
                  />
                )
              })}
            </g>
          ))}
        </svg>
      </div>

      {tooltip && (
        <Tooltip
          hover={tooltip.hover}
          view={{ vx, vy, vw, vh }}
          size={size}
          scaleFit={scaleFit}
        />
      )}

      {/* Zoom controls, mirroring the reference layout. */}
      <div className="absolute right-4 top-4 flex flex-col gap-1.5">
        <button
          onClick={reset}
          title="Reset view"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 bg-white text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 11l9-8 9 8" />
            <path d="M5 10v10h14V10" />
          </svg>
        </button>
        <button
          onClick={() => zoomAt(1.4, 50, 50)}
          title="Zoom in"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 bg-white text-xl leading-none text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          +
        </button>
        <button
          onClick={() => zoomAt(1 / 1.4, 50, 50)}
          title="Zoom out"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-neutral-300 bg-white text-xl leading-none text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          −
        </button>
      </div>

      {selected && (
        <button
          onClick={() => onSelect(null)}
          className="absolute left-4 top-4 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
        >
          Clear selection ✕
        </button>
      )}
    </div>
  )
}

/** Tooltip positioned from venue coords back into screen space. */
function Tooltip({
  hover,
  view,
  size,
  scaleFit,
}: {
  hover: NonNullable<Hover>
  view: { vx: number; vy: number; vw: number; vh: number }
  size: { w: number; h: number }
  scaleFit: number
}) {
  if (!scaleFit) return null
  const r = { width: size.w, height: size.h }

  // The SVG uses preserveAspectRatio=meet, so it letterboxes inside the wrapper.
  const offX = (r.width - view.vw * scaleFit) / 2
  const offY = (r.height - view.vh * scaleFit) / 2
  const left = offX + (hover.x - view.vx) * scaleFit
  const top = offY + (hover.y - view.vy) * scaleFit

  if (left < -80 || top < -80 || left > r.width + 80 || top > r.height + 80) return null

  const cheapest = hover.listings[0]
  const flipX = left > r.width - 240
  const flipY = top > r.height - 130

  return (
    <div
      className="pointer-events-none absolute z-20 w-56 rounded-lg border border-neutral-200 bg-white p-3 shadow-xl"
      style={{
        left: Math.max(4, Math.min(left + (flipX ? -232 : 16), r.width - 232)),
        top: Math.max(4, Math.min(top + (flipY ? -120 : 12), r.height - 120)),
      }}
    >
      <div className="text-xs font-semibold text-neutral-900">{hover.label}</div>
      {cheapest ? (
        <>
          <div className="mt-1.5 text-lg font-bold tabular-nums text-neutral-900">
            {money(cheapest.allInPricePerTicket)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">
            all-in per ticket
          </div>
          <div className="mt-1.5 text-[11px] text-neutral-600">
            {SOURCE_LABELS[cheapest.source]}
            {hover.listings.length > 1 && (
              <span className="text-neutral-400">
                {' '}
                +{hover.listings.length - 1} more
              </span>
            )}
          </div>
          {hover.kind === 'section' && cheapest.seats === null && (
            <div className="mt-1.5 text-[10px] leading-snug text-neutral-500">
              {describeListing(cheapest)} — seat numbers not published
            </div>
          )}
        </>
      ) : (
        <div className="mt-1 text-[11px] text-neutral-500">
          No 2-together listing
        </div>
      )}
    </div>
  )
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The manifest's background art arrives as a full <svg> document. We need its
 * children inside our own viewBox'd svg, so drop the wrapper element.
 */
function stripSvgWrapper(svg: string): string {
  return svg.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '')
}
