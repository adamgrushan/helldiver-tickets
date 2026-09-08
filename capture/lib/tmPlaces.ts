/**
 * Ticketmaster compresses the place-id lists in its facets responses as a
 * nested prefix trie rather than a flat array:
 *
 *   "GEYDAQR2IE5D[C,E]"                -> GEYDAQR2IE5DC, GEYDAQR2IE5DE
 *   "GEYDCOSHHI[2[A,Q],3A,YQ]"         -> GEYDCOSHHI2A, GEYDCOSHHI2Q,
 *                                         GEYDCOSHHI3A, GEYDCOSHHIYQ
 *
 * A bracket group is a set of alternative suffixes, each of which may itself
 * contain groups, to any depth. Everything outside a group is a literal shared
 * by every branch below it.
 *
 * These ids are the same `seatId`s the geometry manifest publishes, which is
 * what lets an offer be resolved to exact seats — including primary offers,
 * whose offer objects carry no section/row/seat at all.
 */

/** Split on commas that sit at bracket depth 0. */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/**
 * Expand one compressed place string into every place id it encodes.
 * Malformed input (unbalanced brackets) yields an empty list rather than a
 * partial guess — a wrong place id would put a dot on the wrong seat.
 */
export function expandPlaces(compressed: string): string[] {
  if (!compressed) return []

  // Bail on unbalanced brackets instead of silently truncating. Checked before
  // the uncompressed fast path, so a stray closing bracket is caught too.
  let depth = 0
  for (const c of compressed) {
    if (c === '[') depth++
    else if (c === ']') depth--
    if (depth < 0) return []
  }
  if (depth !== 0) return []

  if (!compressed.includes('[')) return [compressed]

  const open = compressed.indexOf('[')
  const prefix = compressed.slice(0, open)

  // Find the bracket that closes this group.
  let d = 0
  let close = -1
  for (let i = open; i < compressed.length; i++) {
    if (compressed[i] === '[') d++
    else if (compressed[i] === ']') {
      d--
      if (d === 0) {
        close = i
        break
      }
    }
  }
  if (close === -1) return []

  const inner = compressed.slice(open + 1, close)
  const rest = compressed.slice(close + 1)

  const branches = splitTopLevel(inner).flatMap((alt) => expandPlaces(alt))
  const tails = expandPlaces(rest === '' ? '' : rest)
  const suffixes = rest === '' ? [''] : tails

  const out: string[] = []
  for (const b of branches) {
    for (const t of suffixes) out.push(prefix + b + t)
  }
  return out
}

/** Expand every place string on a facet and dedupe. */
export function expandAll(places: string[] | undefined): string[] {
  if (!places?.length) return []
  return [...new Set(places.flatMap(expandPlaces))]
}
