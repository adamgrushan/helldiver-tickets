/**
 * SeatGeek capture.
 *
 * STATUS AS SHIPPED: **blocked**. SeatGeek serves a DataDome 403 to this network
 * for every path on seatgeek.com (event page, `/api/event_listings_v2`, and even
 * `api.seatgeek.com`), and answers with a CAPTCHA interstitial. Solving that is
 * out of scope, so no listing payload has ever been observed. `captures/raw/seatgeek.json`
 * currently holds the block evidence and, in `_capture.humanTodo`, the exact steps a
 * human takes to drop a real payload in its place. `capture()` throws a message
 * pointing at those steps until that happens — it never invents inventory.
 *
 * The listings endpoint name/shape below IS confirmed from observed traffic: the SPA
 * shell fired it before the block landed. Its *response body* was not.
 *
 * FIELD MAPPING, now verified from a real capture:
 *
 *   p  = base price per ticket (pre-fee)     f  = fee per ticket
 *   pf = p + f, the all-in per-ticket price  dp = pf, rounded, as displayed
 *   ss = explicit seat numbers, e.g. ["12","13","14","15"]
 *   sp = splits (quantities purchasable together)
 *
 * Across all 3,179 rows of the capture, `pf === p + f` and `dp === round(pf)`,
 * and `dp` equals the pre-fee `p` on ZERO rows — so the number emitted here is
 * the fee-inclusive figure SeatGeek itself displays, not a pre-fee price.
 * `assertSane` re-checks that agreement per listing.
 *
 * Two field names are traps and must not be guessed at: `sf` is the section's
 * full name ("Section 106") and `st` is the ticket type ("mobile") — neither is
 * a seat endpoint. Reading them as seat_from/seat_to nulled the seat numbers on
 * every listing.
 *
 * PRE-TAX remains unverified for this source: SeatGeek publishes no tax field,
 * so unlike Ticketmaster there is nothing to subtract or confirm. Same caveat as
 * StubHub; documented in the README.
 *
 * Rather than hardcode a guess at SeatGeek's
 * short price keys, `pickAllInPreTax()` resolves a price only when the payload proves
 * it is fee-inclusive and tax-exclusive, and throws otherwise. A pre-fee price can
 * never reach a `Listing`, and a listing whose price cannot be proven all-in is
 * rejected rather than emitted. Same for the exactly-2 rule: an explicit splits array
 * containing 2 is required, because SeatGeek's "quantity available" field means
 * "2 available", not "2 sellable together".
 *
 * Because that mapping is unverified, three things are deliberately loud rather than
 * convenient: a zero fee component is a rejection (`base + 0` is a pre-fee price), a
 * fee-inclusive field that contradicts `base + fee` by anything other than the tax is
 * a rejection (the sum may be double-counting the fee), and every price caveat is
 * printed by `capture()` together with the field pair each price came from. Whatever
 * this module cannot prove, it refuses and names.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Listing } from '../../src/types.ts'
import { normalizeSection, normalizeRow, seatRange } from '../lib/normalize.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const RAW_JSON = path.join(ROOT, 'captures/raw/seatgeek.json')
const RAW_HTML = path.join(ROOT, 'captures/raw/seatgeek.html')
/**
 * A DevTools HAR export ("Save all as HAR with content"). Preferred manual
 * route: it contains every response body from the page load, so the listings
 * payload can be found by shape rather than by anyone having to identify the
 * right request by name — SeatGeek's endpoint path has moved before.
 */
const RAW_HAR = path.join(ROOT, 'captures/raw/seatgeek.har')

const EVENT_URL =
  'https://seatgeek.com/us-open-tennis-tickets/tennis/2026-09-10-7-pm/17807645?quantity=2'
const EVENT_ID = '17807645'

/** Confirmed from intercepted traffic (the response was 403, the URL shape was not). */
const LISTINGS_ENDPOINT = /\/api\/event_listings_v2|\/web-api\/.*listing/i

// ---------------------------------------------------------------------------
// Field candidates. Ordered; first numeric hit wins within a group.
// ---------------------------------------------------------------------------

/** Pre-fee per-ticket price. NEVER emitted on its own — only as an addend. */
const F_BASE = ['price', 'p', 'base_price', 'ticket_price', 'price_per_ticket'] as const
/** Per-ticket fee total. */
const F_FEE = ['fee', 'f', 'fees', 'service_fee', 'fee_amount', 'total_fees'] as const
/** Claims to already include fees ("pf" = price with fees). */
const F_FEE_INCL = ['pf', 'price_with_fees', 'all_in_price', 'total_price_per_ticket'] as const
/** Tax — must be EXCLUDED from allInPricePerTicket. */
const F_TAX = ['tax', 'tx', 'taxes', 'tax_amount'] as const
/**
 * Whatever the UI is currently printing. Depends on the all-in toggle, so it is
 * NOT a source of truth server-side. Kept only to report a visual cross-check.
 */
const F_DISPLAY = ['display_price', 'dp', 'dpf'] as const

/** Quantities actually purchasable together. NOT the same as "quantity available". */
const F_SPLITS = ['splits', 'sp', 'available_quantities', 'quantities', 'valid_splits'] as const
/** Count on hand. Deliberately unused for the exactly-2 test. */
const F_AVAIL = ['quantity', 'q', 'available_quantity', 'num_tickets'] as const

const F_SECTION = ['section', 's', 'section_name', 'sec', 'section_label'] as const
const F_ROW = ['row', 'r', 'row_name', 'row_label'] as const
const F_ID = ['id', 'listing_id', 'lid', 'uuid'] as const
/**
 * Seat numbers, published as an explicit array: `ss: ["12","13","14","15"]`.
 * This is the authoritative field — ~27% of listings carry it.
 */
const F_SEATS = ['ss', 'seats', 'seat_numbers'] as const
/**
 * Range endpoints, for payload shapes that publish them instead of an array.
 *
 * `sf` and `st` are deliberately NOT candidates: in this payload `sf` is the
 * section's full name ("Section 106") and `st` is the ticket type ("mobile").
 * Guessing them as seat_from/seat_to read those strings as seat labels, which
 * silently nulled the seat numbers on every single listing.
 */
const F_SEAT_FROM = ['seat_from', 'low_seat', 'seat_low', 'first_seat'] as const
const F_SEAT_TO = ['seat_to', 'high_seat', 'seat_high', 'last_seat'] as const

const CENT = 0.02

/**
 * Units tripwire, not a validation. Its only job is to catch a price field that
 * turned out to be minor units (cents) or an order total rather than a per-ticket
 * dollar amount. Top-end inventory for a US Open women's semifinal is low
 * four figures per ticket, so anything at or above this is a units bug, not a
 * real listing. Raise it if this module is ever pointed at a different event.
 */
const MAX_PLAUSIBLE_PER_TICKET = 25000

type Row = Record<string, unknown>

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(/[$,\s]/g, ''))
    if (Number.isFinite(n)) return n
  }
  return null
}

function pickNum(o: Row, keys: readonly string[]): { key: string; value: number } | null {
  for (const k of keys) {
    if (!(k in o)) continue
    const n = num(o[k])
    if (n !== null) return { key: k, value: n }
  }
  return null
}

function pickStr(o: Row, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return null
}

// ---------------------------------------------------------------------------
// Price resolution
// ---------------------------------------------------------------------------

export type PriceChoice = {
  allInPricePerTicket: number
  /** Human-readable provenance, e.g. "price + fee" — goes straight into the report. */
  field: string
  ruledOut: string[]
  warnings: string[]
}

/**
 * Resolve all-in, pre-tax, per-ticket price — or throw.
 *
 * Precedence:
 *  1. base + fee, when both are present AND the fee component is positive.
 *     Provably fee-inclusive and tax-exclusive.
 *  2. a fee-inclusive field ("pf" et al) when nothing suggests tax is folded into
 *     it and it sits strictly above the pre-fee base.
 *  3. nothing else. A bare base price and any display price are refused.
 *
 * Two rules earn their keep because the field mapping is unverified:
 *
 *  - **A zero fee component is refused, not emitted.** `base + 0` is just `base`,
 *    i.e. a pre-fee price, which CONTRACT rule 4 forbids outright. SeatGeek always
 *    charges a fee, so a zero here means the wrong key was read, not a free listing.
 *  - **A fee-inclusive field that contradicts `base + fee` is a rejection, not a
 *    warning.** If `pf` disagrees and the gap is not the tax, then one of the three
 *    fields is not what its name suggests and the sum may double-count the fee
 *    (when `base` is itself already all-in) or undercount it (when `fee` is partial).
 *    Emitting either number would be a guess.
 */
export function pickAllInPreTax(l: Row): PriceChoice {
  const base = pickNum(l, F_BASE)
  const fee = pickNum(l, F_FEE)
  const feeIncl = pickNum(l, F_FEE_INCL)
  const tax = pickNum(l, F_TAX)
  const display = pickNum(l, F_DISPLAY)

  const ruledOut: string[] = []
  const warnings: string[] = []
  if (base) ruledOut.push(`${base.key}=${base.value} (pre-fee base — banned by CONTRACT rule 4)`)
  if (tax) ruledOut.push(`${tax.key}=${tax.value} (tax — excluded by definition)`)
  if (display)
    ruledOut.push(`${display.key}=${display.value} (UI display price — depends on the all-in toggle)`)

  // --- 1. base + fee -------------------------------------------------------
  if (base && fee) {
    const allIn = round2(base.value + fee.value)
    if (feeIncl) {
      const d = round2(feeIncl.value - allIn)
      if (Math.abs(d) <= CENT) {
        // pf agrees, and therefore also excludes tax.
      } else if (tax && Math.abs(d - tax.value) <= CENT) {
        ruledOut.push(
          `${feeIncl.key}=${feeIncl.value} (equals base+fee+${tax.key} — it folds tax in, so it is post-tax)`,
        )
      } else if (Math.abs(feeIncl.value - base.value) <= CENT && fee.value > CENT) {
        // pf == base while fee > 0: base is ITSELF fee-inclusive (this is what the
        // site's all-in toggle does to the payload), so base + fee double-counts
        // the fee. Take the fee-inclusive field and say so loudly.
        warnings.push(
          `${feeIncl.key}=${feeIncl.value} equals ${base.key}, so ${base.key} is ALREADY fee-inclusive and ` +
            `${base.key}+${fee.key}=${allIn} would double-count ${fee.key}=${fee.value}. Used ${feeIncl.key}. ` +
            `Cross-check one listing against the site before trusting this run.`,
        )
        return {
          allInPricePerTicket: assertSane(round2(feeIncl.value), l),
          field: feeIncl.key,
          ruledOut,
          warnings,
        }
      } else {
        throw new Error(
          `listing ${describe(l)}: ${feeIncl.key}=${feeIncl.value} contradicts ${base.key}+${fee.key}=${allIn} ` +
            `by ${d}, and that gap is not ${tax ? `${tax.key}=${tax.value}` : 'any tax field (none present)'}. ` +
            `One of these fields is not what its name suggests, so neither number is provably all-in pre-tax. ` +
            `Refusing to guess (CONTRACT rule 4).`,
        )
      }
    }
    if (fee.value <= CENT) {
      throw new Error(
        `listing ${describe(l)}: ${fee.key}=${fee.value}, so ${base.key}+${fee.key} is just the pre-fee ` +
          `${base.key}=${base.value}. A pre-fee price must never be written to a Listing (CONTRACT rule 4). ` +
          `SeatGeek always charges a fee, so this means ${fee.key} is the wrong key, not that the listing is fee-free.`,
      )
    }
    return {
      allInPricePerTicket: assertSane(allIn, l),
      field: `${base.key} + ${fee.key}`,
      ruledOut,
      warnings,
    }
  }

  // --- 2. a fee-inclusive field -------------------------------------------
  if (feeIncl) {
    if (tax && tax.value > 0) {
      if (base && Math.abs(feeIncl.value - base.value - tax.value) <= CENT) {
        throw new Error(
          `listing ${describe(l)}: ${feeIncl.key} equals ${base.key}+${tax.key}, so it is post-tax with no fee component. Cannot derive an all-in pre-tax price.`,
        )
      }
      throw new Error(
        `listing ${describe(l)}: ${feeIncl.key}=${feeIncl.value} is present alongside ${tax.key}=${tax.value} but no fee field, so whether ${feeIncl.key} includes tax is unresolvable. Refusing to guess.`,
      )
    }
    if (base && feeIncl.value < base.value - CENT) {
      throw new Error(
        `listing ${describe(l)}: ${feeIncl.key}=${feeIncl.value} is below ${base.key}=${base.value}; it is not a fee-inclusive price.`,
      )
    }
    if (base && Math.abs(feeIncl.value - base.value) <= CENT) {
      throw new Error(
        `listing ${describe(l)}: ${feeIncl.key} equals ${base.key} (${base.value}), so the resolved price carries ` +
          `no fee component and is indistinguishable from the pre-fee base. Either ${feeIncl.key} is not ` +
          `fee-inclusive or the fee lives in a key this module does not know. Refusing to emit a possibly ` +
          `pre-fee price (CONTRACT rule 4). Saw keys [${Object.keys(l).join(', ')}].`,
      )
    }
    if (!base) {
      warnings.push(
        `${feeIncl.key}=${feeIncl.value} used with no base-price field alongside it, so "fee-inclusive" rests on ` +
          `the key name alone. Cross-checked against the payload's display price where present.`,
      )
    }
    return {
      allInPricePerTicket: assertSane(round2(feeIncl.value), l),
      field: feeIncl.key,
      ruledOut,
      warnings,
    }
  }

  // --- 3. refuse -----------------------------------------------------------
  throw new Error(
    `listing ${describe(l)}: no fee-inclusive price available. Saw keys [${Object.keys(l).join(', ')}]. ` +
      `A pre-fee or display-only price must never be written to a Listing (CONTRACT rule 4).`,
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Guard against reading the wrong price field — an order total, or a
 * minor-unit (cents) value — without discarding genuinely expensive seats.
 *
 * An absolute ceiling is the wrong test here: courtside inventory for this
 * event really does run past $38,000 per ticket, and a flat $25k tripwire threw
 * away 29 legitimate listings, i.e. exactly the premium end of the market.
 *
 * What actually distinguishes a real price from a misread field is internal
 * agreement. SeatGeek publishes the same number three ways — `p` (base),
 * `f` (fee), `pf` (price with fees) and `dp` (the rounded figure it displays) —
 * and across all 3,179 rows of the real capture `pf === p + f` and
 * `dp === round(pf)` exactly. A cents/dollars mix-up or an order total would
 * break that agreement immediately, at any magnitude. So the price is validated
 * against the source's own arithmetic instead of against a guess about how
 * expensive a tennis ticket is allowed to be.
 */
function assertSane(n: number, l: Row): number {
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`listing ${describe(l)}: non-positive or non-numeric price ${n}`)
  }

  const base = num(l['p'])
  const fee = num(l['f'])
  const withFees = num(l['pf'])
  const display = num(l['dp'])

  // `pf` must equal base + fee where all three exist.
  if (base !== null && fee !== null && withFees !== null) {
    if (Math.abs(withFees - (base + fee)) > 0.011) {
      throw new Error(
        `listing ${describe(l)}: pf ${withFees} != p ${base} + f ${fee} — ` +
          'the price fields disagree, so which one is fee-inclusive is unknown.',
      )
    }
  }

  // The emitted number must be the one the site displays (dp is pf, rounded).
  if (display !== null && Math.abs(display - n) > 1.51) {
    throw new Error(
      `listing ${describe(l)}: emitted ${n} but the site displays ${display} — ` +
        'likely the wrong price field (an order total, or a minor-unit value).',
    )
  }

  // Backstop for a payload that publishes none of the cross-check fields.
  if (display === null && withFees === null && n >= MAX_PLAUSIBLE_PER_TICKET) {
    throw new Error(
      `listing ${describe(l)}: implausible per-ticket price ${n} with no cross-check ` +
        `field available (tripwire at ${MAX_PLAUSIBLE_PER_TICKET}).`,
    )
  }
  return n
}

/**
 * Read an explicitly published seat array. Only string/number entries count —
 * anything else means the field isn't what we think it is.
 */
function pickSeatArray(l: Row): string[] | null {
  for (const k of F_SEATS) {
    const v = l[k]
    if (!Array.isArray(v) || v.length === 0) continue
    const seats = v
      .filter((x) => typeof x === 'string' || typeof x === 'number')
      .map((x) => String(x).trim())
      .filter(Boolean)
    if (seats.length === v.length) return seats
  }
  return null
}

function describe(l: Row): string {
  const id = pickStr(l, F_ID) ?? '<no id>'
  const sec = pickStr(l, F_SECTION) ?? '?'
  const row = pickStr(l, F_ROW) ?? '?'
  return `${id} (sec ${sec} row ${row})`
}

// ---------------------------------------------------------------------------
// Exactly-2-together
// ---------------------------------------------------------------------------

/** Parse a splits/quantities value into numbers. Accepts [2,4], "2,4", or 2. */
function toQuantities(v: unknown): number[] | null {
  if (Array.isArray(v)) {
    const out = v.map(num).filter((n): n is number => n !== null)
    return out.length ? out : null
  }
  if (typeof v === 'string' && /[\d]/.test(v)) {
    const out = v
      .split(/[,;|\s]+/)
      .map(num)
      .filter((n): n is number => n !== null)
    return out.length ? out : null
  }
  const n = num(v)
  return n === null ? null : [n]
}

/** True only when the payload explicitly says 2 is a purchasable split. */
export function sellableAsExactlyTwo(l: Row): boolean {
  const unparseable: string[] = []
  for (const k of F_SPLITS) {
    if (!(k in l)) continue
    const qs = toQuantities(l[k])
    if (qs) return qs.includes(2)
    // The key IS there but held nothing numeric (empty array, null, "1-4", …).
    // Say so — "field missing" would send a human looking for the wrong problem.
    unparseable.push(`${k}=${JSON.stringify(l[k])}`)
  }
  const avail = pickNum(l, F_AVAIL)
  throw new Error(
    `listing ${describe(l)}: no usable splits/purchasable-quantities field. ` +
      (unparseable.length
        ? `Present but unparseable: [${unparseable.join(', ')}]. `
        : `Looked for ${F_SPLITS.join('/')}; none present. `) +
      (avail
        ? `Only ${avail.key}=${avail.value} is present, which means "${avail.value} available", not "2 sellable together". `
        : '') +
      `Refusing to assume exactly-2 is honored.`,
  )
}

// ---------------------------------------------------------------------------
// Payload location
// ---------------------------------------------------------------------------

function looksLikeListing(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Row
  const hasPrice = pickNum(o, [...F_BASE, ...F_FEE_INCL, ...F_DISPLAY]) !== null
  const hasPlace = pickStr(o, F_SECTION) !== null
  return hasPrice && hasPlace
}

/** Depth-first hunt for the listings array, so an unknown wrapper shape still parses. */
export function findListingsArray(payload: unknown): Row[] | null {
  const seen = new Set<unknown>()
  const stack: unknown[] = [payload]
  let best: Row[] | null = null
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      const hits = node.filter(looksLikeListing) as Row[]
      if (hits.length && (!best || hits.length > best.length)) best = hits
      for (const v of node) stack.push(v)
      continue
    }
    for (const v of Object.values(node as Row)) stack.push(v)
  }
  return best
}

/** Pull an embedded JSON blob out of a manually-saved HTML page. */
export function extractEmbeddedJson(html: string): unknown | null {
  const patterns = [
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /window\.__[A-Z_]+__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i,
  ]
  for (const re of patterns) {
    const all = re.global ? [...html.matchAll(re)] : [html.match(re)].filter(Boolean)
    for (const m of all) {
      const body = m?.[1]
      if (!body) continue
      try {
        const parsed: unknown = JSON.parse(body.trim())
        if (findListingsArray(parsed)) return parsed
      } catch {
        // not JSON, or not the blob we want — keep looking
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Raw file
// ---------------------------------------------------------------------------

type Raw = { payload: unknown; capturedAt: string; from: string }

type HarEntry = {
  startedDateTime?: string
  request?: { url?: string }
  response?: { content?: { text?: string; encoding?: string } }
}

/**
 * Scan a HAR for the response that carries the listings.
 *
 * Every JSON body is tried and scored by how many listing-shaped rows it holds;
 * the richest wins. Naming the endpoint is deliberately not required — the HAR
 * route exists precisely because the endpoint name is not stable.
 */
function loadFromHar(harText: string): Raw {
  // An empty file is the common failure when a save dialog creates the file but
  // the export never writes — worth naming, because "unexpected end of JSON"
  // reads like a corrupt capture rather than a save that didn't happen.
  if (!harText.trim()) {
    throw new Error(
      `${RAW_HAR} is empty (0 bytes) — the HAR export created the file but wrote nothing. ` +
        'In the Network panel use right-click > "Save all as HAR with content" (not the plain ' +
        '"Save as HAR" / download-arrow, which can produce an empty file), wait for the save to ' +
        'finish, and check the file is a few MB before re-running.',
    )
  }
  let har: { log?: { entries?: HarEntry[] } }
  try {
    har = JSON.parse(harText)
  } catch (e) {
    throw new Error(
      `${RAW_HAR} is not valid JSON (${(e as Error).message}). ` +
        'Make sure it is a HAR export and that the save completed.',
    )
  }
  const entries = har.log?.entries ?? []
  if (!entries.length) throw new Error(`${RAW_HAR} contains no entries`)

  /**
   * Chrome's "sanitized" HAR export drops response bodies: each entry keeps
   * `content: { size, mimeType }` with no `text`. Detect that specifically —
   * the HAR is otherwise a perfectly good capture, and the fix is to copy the
   * one listings response rather than re-export everything.
   */
  const anyBody = entries.some((e) => e.response?.content?.text)
  const anySize = entries.some((e) => (e.response?.content as { size?: number } | undefined)?.size)
  if (!anyBody && anySize) {
    const candidates = entries
      .filter((e) => /event_listings|listings/i.test(e.request?.url ?? ''))
      .map((e) => ({
        url: e.request?.url ?? '',
        mb: ((e.response?.content as { size?: number } | undefined)?.size ?? 0) / 1e6,
      }))
      .sort((a, b) => b.mb - a.mb)
    throw new Error(
      `${RAW_HAR} has ${entries.length} entries but NO response bodies — it is a ` +
        '"sanitized" / headers-only HAR export, which strips response content.\n' +
        (candidates.length
          ? `  Good news: the listings request is in there (${candidates[0].mb.toFixed(2)} MB of JSON), ` +
            'so the capture worked and the session is not blocked.\n' +
            `  ${candidates[0].url.slice(0, 150)}\n` +
            '  Fastest fix: in the Network panel filter for "event_listings_v2", click that request, ' +
            'right-click > Copy > "Copy response", then:\n' +
            '    pbpaste > captures/raw/seatgeek.json\n' +
            '  (delete captures/raw/seatgeek.har first so it does not take precedence)'
          : '  Re-export with response bodies included, or copy the single listings response ' +
            'to captures/raw/seatgeek.json.'),
    )
  }

  let best: { rows: number; payload: unknown; url: string; when?: string } | null = null
  let sawBlockPage = false

  for (const entry of entries) {
    const content = entry.response?.content
    let text = content?.text
    if (!text) continue
    if (content?.encoding === 'base64') {
      try {
        text = Buffer.from(text, 'base64').toString('utf8')
      } catch {
        continue
      }
    }
    if (/captcha-delivery|geo\.captcha/i.test(text)) sawBlockPage = true
    if (!/[[{]/.test(text.slice(0, 200))) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON — could still be the HTML document with an embedded payload.
      const embedded = /<html/i.test(text) ? extractEmbeddedJson(text) : null
      if (!embedded) continue
      parsed = embedded
    }
    const rows = findListingsArray(parsed)
    if (!rows?.length) continue
    if (!best || rows.length > best.rows) {
      best = {
        rows: rows.length,
        payload: parsed,
        url: entry.request?.url ?? '(unknown url)',
        when: entry.startedDateTime,
      }
    }
  }

  if (!best) {
    // Distinguish the three ways a HAR comes back empty of listings, because the
    // fix is different for each and the wrong hint sends you in circles.
    let why: string
    const assetish = entries.filter((e) =>
      /\.(png|jpe?g|webp|gif|svg|css|woff2?)(\?|$)|seatgeekimages\.com|\/seatviews\//i.test(
        e.request?.url ?? '',
      ),
    ).length
    if (sawBlockPage) {
      why =
        'At least one response was a DataDome block page, so the session that produced this HAR was still blocked.'
    } else if (entries.length < 40 && assetish >= entries.length / 2) {
      // Seat-view thumbnails load only as you interact with rendered listings,
      // so their presence means the page WAS working — DevTools simply started
      // recording after the listings request had already gone out.
      why =
        `Only ${entries.length} entries, mostly images/assets — DevTools started recording after the page had already loaded, ` +
        'so the listings request was never captured. Fix: keep DevTools open, tick "Preserve log" in the Network panel, ' +
        'then RELOAD the page (Cmd+R) with DevTools open, wait for the listings to render, and export again.'
    } else {
      why =
        'Make sure the listings panel had actually rendered (set quantity to 2 and scroll the list) before exporting, ' +
        'and that the export was "Save all as HAR with content" — a HAR without response bodies cannot be parsed.'
    }
    throw new Error(`${RAW_HAR} has ${entries.length} entries but none contained a listings array. ${why}`)
  }

  console.log(
    `[seatgeek] HAR: ${best.rows} listing rows from ${best.url.slice(0, 120)}`,
  )
  return {
    payload: best.payload,
    capturedAt: best.when ?? new Date().toISOString(),
    from: RAW_HAR,
  }
}

function loadRaw(): Raw {
  // HAR first: it is the route that does not depend on endpoint naming.
  if (existsSync(RAW_HAR)) return loadFromHar(readFileSync(RAW_HAR, 'utf8'))

  if (existsSync(RAW_JSON)) {
    const text = readFileSync(RAW_JSON, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new Error(`${RAW_JSON} is not valid JSON: ${(e as Error).message}`)
    }
    const meta = (parsed as Row)?._capture as Row | undefined
    if (meta && !findListingsArray(parsed)) {
      const todo = Array.isArray(meta.humanTodo) ? meta.humanTodo : []
      throw new Error(
        `SeatGeek capture is BLOCKED (${String(meta.blockedBy ?? 'bot detection')}). ` +
          `captures/raw/seatgeek.json holds the block evidence, not inventory — no listings were ever served. ` +
          `A human must save a real payload:\n` +
          todo.map((s, i) => `  ${i + 1}. ${String(s)}`).join('\n'),
      )
    }
    return {
      payload: parsed,
      capturedAt: typeof meta?.attemptedAt === 'string' ? meta.attemptedAt : new Date().toISOString(),
      from: RAW_JSON,
    }
  }
  if (existsSync(RAW_HTML)) {
    const html = readFileSync(RAW_HTML, 'utf8')
    if (/captcha-delivery|Please enable JS and disable any ad blocker/i.test(html)) {
      throw new Error(
        `${RAW_HTML} is a DataDome block page, not the event page. Re-save the rendered listings page from a browser that is not blocked.`,
      )
    }
    const embedded = extractEmbeddedJson(html)
    if (!embedded) {
      throw new Error(
        `${RAW_HTML} contains no embedded listings JSON (looked for __NEXT_DATA__, application/json scripts, window.__*__). ` +
          `Prefer saving the /api/event_listings_v2 response to captures/raw/seatgeek.json instead.`,
      )
    }
    return { payload: embedded, capturedAt: new Date().toISOString(), from: RAW_HTML }
  }
  throw new Error(
    `No SeatGeek raw capture found. Expected ${RAW_HAR}, ${RAW_JSON} or ${RAW_HTML}. ` +
      `Set SEATGEEK_REFRESH=1 to attempt a live headed capture (currently DataDome-blocked from this network).`,
  )
}

// ---------------------------------------------------------------------------
// Live refresh (opt-in via SEATGEEK_REFRESH=1)
// ---------------------------------------------------------------------------

/**
 * Passive interception: load the event page headed and record what SeatGeek's own
 * frontend fetches. No CAPTCHA solving, no proxying, no fingerprint spoofing — if
 * the block is up this writes nothing and the file path stays authoritative.
 */
async function refresh(): Promise<void> {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()

  let captured: unknown = null
  page.on('response', async (res) => {
    if (!LISTINGS_ENDPOINT.test(res.url()) || res.status() !== 200) return
    try {
      const body: unknown = await res.json()
      if (findListingsArray(body)) captured = body
    } catch {
      // non-JSON or block page
    }
  })

  let blocked = false
  try {
    await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
    // Give the listings panel time to render and lazy-load its inventory.
    await page.waitForTimeout(15000)
    for (let i = 0; i < 6 && !captured; i++) {
      await page.mouse.wheel(0, 900)
      await page.waitForTimeout(2500)
    }
    blocked = /captcha-delivery/.test(await page.content().catch(() => ''))
  } finally {
    await browser.close()
  }

  if (!captured) {
    throw new Error(
      blocked
        ? 'Live refresh blocked: SeatGeek served a DataDome CAPTCHA interstitial. Not solving it. Save the payload manually per captures/raw/seatgeek.json > _capture.humanTodo.'
        : 'Live refresh saw no event_listings_v2 payload.',
    )
  }

  mkdirSync(path.dirname(RAW_JSON), { recursive: true })
  // The payload is NESTED, never spread. `event_listings_v2` may answer with a
  // top-level array, and spreading an array into an object turns it into
  // {"0":…,"1":…} — which findListingsArray can no longer see, so the next
  // capture() would misreport a good pull as "blocked". `findListingsArray`
  // recurses through object values, so nesting parses either shape.
  writeFileSync(
    RAW_JSON,
    JSON.stringify(
      {
        _capture: {
          source: 'seatgeek',
          status: 'ok',
          attemptedAt: new Date().toISOString(),
          eventUrl: EVENT_URL,
          endpoint: String(LISTINGS_ENDPOINT),
          method: 'api',
        },
        payload: captured,
      },
      null,
      2,
    ) + '\n',
  )
}

// ---------------------------------------------------------------------------
// capture()
// ---------------------------------------------------------------------------

export async function capture(opts?: { refresh?: boolean }): Promise<Listing[]> {
  if (opts?.refresh || process.env.SEATGEEK_REFRESH === '1') await refresh()

  const raw = loadRaw()
  const rows = findListingsArray(raw.payload)
  if (!rows || rows.length === 0) {
    throw new Error(`No listings array found in ${raw.from}.`)
  }

  const vocab = JSON.parse(
    readFileSync(path.join(ROOT, 'capture/lib/venue-vocab.json'), 'utf8'),
  ) as { sectionIds: string[] }
  const valid = new Set(vocab.sectionIds)

  const out: Listing[] = []
  const unmatchedSections = new Set<string>()
  const rejected: string[] = []
  const priceWarnings: string[] = []
  const priceFields: string[] = []
  const seatWarnings: string[] = []
  const seen = new Set<string>()

  for (const l of rows) {
    // --- exactly 2 together ---
    let two = false
    try {
      two = sellableAsExactlyTwo(l)
    } catch (e) {
      rejected.push((e as Error).message)
      continue
    }
    if (!two) continue

    // --- all-in, pre-tax, per ticket ---
    let price: PriceChoice
    try {
      price = pickAllInPreTax(l)
    } catch (e) {
      rejected.push((e as Error).message)
      continue
    }

    // --- section must land in the venue vocabulary ---
    const rawSection = pickStr(l, F_SECTION)
    const section = normalizeSection(rawSection)
    if (!valid.has(section)) {
      unmatchedSections.add(rawSection ?? '<missing>')
      continue
    }

    const id = pickStr(l, F_ID)
    if (!id) {
      rejected.push(`listing in section ${section} has no id field; cannot key it.`)
      continue
    }
    if (seen.has(id)) {
      rejected.push(`duplicate listing id ${id} (section ${section}); kept the first occurrence only.`)
      continue
    }
    seen.add(id)

    // Every emitted listing is, by the filter above, a purchasable PAIR. So the
    // only honest seat list is one naming exactly the 2 seats. A single endpoint
    // names one seat of a pair; a longer run is the listing's whole seat block,
    // out of which some 2 would be assigned — and `seatRange` interpolates the
    // interior numbers, which the source never published. CONTRACT rule 6 says
    // `null` is correct when the source doesn't publish the seat numbers, and
    // never to infer them, so anything but a clean pair becomes null and is
    // reported instead.
    let seats = pickSeatArray(l) ?? seatRange(pickStr(l, F_SEAT_FROM), pickStr(l, F_SEAT_TO))
    if (seats && seats.length !== 2) {
      seatWarnings.push(
        `${id}: ${seats.length === 1 ? 'only one seat number' : `a ${seats.length}-seat block`} ` +
          `(${seats[0]}–${seats[seats.length - 1]}) for a 2-ticket listing; emitted seats: null.`,
      )
      seats = null
    }

    if (price.warnings.length) priceWarnings.push(`${id}: ${price.warnings.join(' ')}`)
    priceFields.push(price.field)

    out.push({
      source: 'seatgeek',
      sourceListingId: id,
      section,
      row: normalizeRow(pickStr(l, F_ROW)),
      seats,
      allInPricePerTicket: price.allInPricePerTicket,
      listingUrl: `${EVENT_URL}&listing=${encodeURIComponent(id)}`,
      capturedAt: raw.capturedAt,
    })
  }

  if (out.length === 0) {
    throw new Error(
      `SeatGeek: ${rows.length} candidate rows in ${raw.from}, but none survived. ` +
        `Unmatched sections: [${[...unmatchedSections].join(', ')}]. ` +
        `First rejections: ${rejected.slice(0, 5).join(' | ')}`,
    )
  }
  if (unmatchedSections.size) {
    console.warn(
      `[seatgeek] sections not in venue-vocab, not emitted: ${[...unmatchedSections].join(', ')}`,
    )
  }
  if (rejected.length) {
    console.warn(`[seatgeek] ${rejected.length} rows rejected; first: ${rejected[0]}`)
  }
  // Price provenance, and every price caveat, has to reach a human — this module's
  // field mapping is unverified, so a silently-swallowed warning is the one way a
  // wrong price gets shipped looking clean.
  const provenance = new Map<string, number>()
  for (const f of priceFields) provenance.set(f, (provenance.get(f) ?? 0) + 1)
  console.warn(
    `[seatgeek] ${out.length} listings; price resolved from ` +
      [...provenance].map(([f, n]) => `"${f}" x${n}`).join(', ') +
      ' (fee-inclusive: verified against the payload\'s own display price; ' +
        'pre-tax: not verifiable — SeatGeek publishes no tax field)',
  )
  if (seatWarnings.length) {
    console.warn(
      `[seatgeek] ${seatWarnings.length} listings had a seat range that was not a clean pair; ` +
        `emitted seats: null for those. First: ${seatWarnings[0]}`,
    )
  }
  for (const w of priceWarnings) console.warn(`[seatgeek] PRICE WARNING ${w}`)
  return out
}

/** Exported so the scratch runner can print provenance without a main() here. */
export const meta = { EVENT_URL, EVENT_ID, RAW_JSON, RAW_HTML, LISTINGS_ENDPOINT } as const
