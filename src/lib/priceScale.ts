/**
 * Price -> color, shared by the map dots, the section tints, and the legend.
 *
 * Ticket prices are heavily right-skewed (a handful of courtside listings sit an
 * order of magnitude above the promenade), so a linear ramp would collapse the
 * entire cheap end into one indistinguishable color. Ranking each price against
 * the observed distribution instead gives every tier visible separation.
 */

/** Cheap -> expensive. Blue reads "deal", red reads "premium". */
export const PRICE_COLORS = [
  '#1d4ed8', // blue
  '#0284c7', // sky
  '#059669', // green
  '#ca8a04', // amber
  '#ea580c', // orange
  '#dc2626', // red
] as const

export type PriceScale = {
  /** Color for one price. */
  color: (price: number) => string
  /** Legend bands, cheapest first. */
  bands: Array<{ color: string; min: number; max: number }>
  min: number
  max: number
}

/**
 * Build a scale from every price in play. Bands are quantile-based, so each
 * carries a comparable share of the inventory.
 */
export function buildPriceScale(prices: number[]): PriceScale {
  const sorted = [...prices].sort((a, b) => a - b)
  const n = sorted.length
  const bandCount = PRICE_COLORS.length

  if (n === 0) {
    return {
      color: () => PRICE_COLORS[0],
      bands: [],
      min: 0,
      max: 0,
    }
  }

  // Quantile edges: bands[i] covers prices in [edge(i), edge(i+1)).
  const edges: number[] = []
  for (let i = 0; i <= bandCount; i++) {
    edges.push(sorted[Math.min(n - 1, Math.floor((i / bandCount) * n))])
  }
  edges[bandCount] = sorted[n - 1]

  const bands = PRICE_COLORS.map((color, i) => ({
    color,
    min: edges[i],
    max: edges[i + 1],
  }))
    // Distinct prices can be fewer than bands; drop the collapsed ones so the
    // legend never shows an empty $X–$X row.
    .filter((b, i) => i === 0 || b.max > b.min)

  const color = (price: number): string => {
    for (let i = bands.length - 1; i >= 0; i--) {
      if (price >= bands[i].min) return bands[i].color
    }
    return bands[0]?.color ?? PRICE_COLORS[0]
  }

  return { color, bands, min: sorted[0], max: sorted[n - 1] }
}

export const money = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/** Compact form for axis/legend labels: $1,409 not $1,409.00. */
export const moneyShort = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
