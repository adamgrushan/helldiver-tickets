/**
 * Section label normalization.
 *
 * The venue manifest, Ticketmaster's inventory API, and the venue SVG each spell
 * the same section differently ("100 B" / "100B" / "100B"). Resale sites add more
 * variants ("Section 100B", "Promenade 318", "100-B"). Everything is folded to a
 * single canonical id before it reaches the map.
 */

/** Canonical form: uppercase, no separators. "100 B" -> "100B". */
export function normalizeSection(raw: string | null | undefined): string {
  if (raw == null) return ''
  let s = String(raw).trim().toUpperCase()

  // Strip common prefixes resale sites prepend to the bare section id.
  s = s.replace(
    /^(SECTION|SEC\.?|SECT\.?|BOX|LOGE|PROMENADE|PROM\.?|SUITE|LEVEL|LVL\.?)\s+/g,
    '',
  )
  // Drop separators: "100-B", "100 B", "100_B" -> "100B".
  s = s.replace(/[\s\-_.]+/g, '')
  return s
}

/** Row labels: uppercase, trimmed; empty/placeholder becomes null. */
export function normalizeRow(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const s = String(raw).trim().toUpperCase().replace(/^ROW\s+/, '')
  if (!s || s === 'GA' || s === 'N/A' || s === '-') return null
  return s
}

/**
 * Expand a seat range to explicit seat numbers.
 * Sources publish either a range ("23" to "24") or a list.
 * Returns null when the source doesn't publish seat numbers at all.
 */
export function seatRange(
  from: string | null | undefined,
  to: string | null | undefined,
): string[] | null {
  if (!from) return null
  if (!to || to === from) return [String(from)]
  const a = Number(from)
  const b = Number(to)
  // Non-numeric seat labels can't be safely interpolated — keep the endpoints.
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [String(from), String(to)]
  if (b < a) return [String(to), String(from)]
  // Guard against absurd ranges from bad data.
  if (b - a > 60) return [String(from), String(to)]
  const out: string[] = []
  for (let i = a; i <= b; i++) out.push(String(i))
  return out
}
