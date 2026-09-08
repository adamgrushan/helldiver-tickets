/**
 * Capture orchestrator.
 *
 * Exposes `runAllCaptures()` — the single entry point that runs every source,
 * dedupes, and returns the bundle the UI reads. `scripts/capture.ts` is a thin
 * CLI wrapper around it that writes the file.
 *
 * This split is the seam for the future local endpoint: a `POST /api/capture`
 * handler would call this exact function and stream its status back, with no
 * change to either the sources or the UI. The UI never imports from here — it
 * reads the JSON this produces.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  CaptureBundle,
  CaptureFn,
  Listing,
  Source,
  SourceStatus,
  Venue,
} from '../src/types.ts'
import { SOURCES } from '../src/types.ts'
import { dedupe } from './lib/dedupe.ts'
import { nullifyUnplaceableSeats } from './lib/placeSeats.ts'
import { jitter } from './lib/browser.ts'

/**
 * Sources are loaded lazily, one at a time.
 *
 * A static import would mean a single unloadable module (syntax error, missing
 * file, bad import) takes down the whole run before any source is tried — which
 * contradicts "sources fail independently". Loading inside the try means a
 * broken module is recorded as that one source failing.
 */
async function loadAdapter(source: Source): Promise<CaptureFn> {
  const mod: { capture?: CaptureFn } = await import(`./sources/${source}.ts`)
  if (typeof mod.capture !== 'function') {
    throw new Error(`capture/sources/${source}.ts does not export capture()`)
  }
  return mod.capture
}

/**
 * How each source obtained its data, for the UI's provenance line.
 *
 * 'api' means the module can re-capture unattended. 'manual-file' means a human
 * has to clear an interstitial (StubHub) or save the payload by hand (SeatGeek)
 * before the parser has anything to read.
 */
const METHODS: Record<Source, SourceStatus['method']> = {
  ticketmaster: 'api',
  stubhub: 'manual-file',
  seatgeek: 'manual-file',
  ticketliquidator: 'api',
  vividseats: 'api',
}

const EVENT = {
  name: "US Open Women's Singles Semifinals",
  venue: 'Arthur Ashe Stadium',
  startsAt: '2026-09-10T19:00:00-04:00',
  quantity: 2 as const,
}

/**
 * Per-source results are cached here so a partial run stays correct.
 *
 * Without this, `capture -- seatgeek` would rebuild the bundle from one source
 * and silently discard the other four — the dedupe pass operates on the union,
 * so it needs every source's listings even when only one was re-run.
 */
const CACHE_DIR = 'captures/by-source'

type CachedSource = { status: SourceStatus; listings: Listing[] }

function cachePath(source: Source): string {
  return `${CACHE_DIR}/${source}.json`
}

function readCache(source: Source): CachedSource | null {
  const p = cachePath(source)
  if (!existsSync(p)) return null
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as CachedSource
    return Array.isArray(c?.listings) && c?.status ? c : null
  } catch {
    // A corrupt cache entry should behave like a missing one, not crash a run.
    return null
  }
}

function writeCache(source: Source, entry: CachedSource): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(source), JSON.stringify(entry))
}

export type RunOptions = {
  /** Restrict the run to these sources. Defaults to all. */
  only?: Source[]
  /** Called as each source finishes, so a caller can show progress. */
  onProgress?: (status: SourceStatus) => void
}

export async function runAllCaptures(opts: RunOptions = {}): Promise<CaptureBundle> {
  const targets = opts.only?.length ? opts.only : [...SOURCES]
  const statuses: SourceStatus[] = []
  const collected: Listing[] = []

  // Sequential, with a pause between sources. These sites challenge clients that
  // behave mechanically, and nothing here is time-critical — this is a one-time
  // pull, so there is no reason to run them concurrently.
  for (const [i, source] of targets.entries()) {
    const startedAt = new Date().toISOString()
    try {
      const adapter = await loadAdapter(source)
      const listings = await adapter()
      // A source returning a wrong-source listing would corrupt the panel's
      // badges and the dedupe's provenance.
      const foreign = listings.filter((l) => l.source !== source)
      if (foreign.length) {
        throw new Error(
          `${source} returned ${foreign.length} listing(s) tagged as another source`,
        )
      }
      collected.push(...listings)
      const status: SourceStatus = {
        source,
        status: 'ok',
        capturedAt: listings[0]?.capturedAt ?? startedAt,
        listingCount: listings.length,
        method: METHODS[source],
      }
      statuses.push(status)
      writeCache(source, { status, listings })
      opts.onProgress?.(status)
      console.log(`  ${source}: ok — ${listings.length} listings`)
    } catch (err) {
      // Sources fail independently; one block must not sink the run.
      const status: SourceStatus = {
        source,
        status: 'failed',
        capturedAt: startedAt,
        listingCount: 0,
        method: METHODS[source],
        error: err instanceof Error ? err.message : String(err),
      }
      statuses.push(status)
      // A source that fails now supersedes its cached success: reporting stale
      // listings as current would be worse than reporting the failure.
      writeCache(source, { status, listings: [] })
      opts.onProgress?.(status)
      console.log(`  ${source}: FAILED — ${status.error}`)
    }

    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, jitter(3000)))
    }
  }

  // Fold in sources this run skipped, so a partial run still produces a whole
  // bundle rather than replacing it with a slice.
  for (const source of SOURCES) {
    if (targets.includes(source)) continue
    const cached = readCache(source)
    if (!cached) continue
    collected.push(...cached.listings)
    statuses.push(cached.status)
    console.log(
      `  ${source}: reused cached capture — ${cached.listings.length} listings`,
    )
  }
  // Keep the panel's status order stable regardless of what ran.
  statuses.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source))

  // Discard seat numbers that don't resolve against the venue manifest, before
  // dedupe — seat identity is part of the dedupe key, so a bogus pair would
  // wrongly block a legitimate collapse.
  const venue: Venue = JSON.parse(readFileSync('src/data/venue.json', 'utf8'))
  const checked = nullifyUnplaceableSeats(collected, venue)
  if (checked.nulled.length) {
    const bySource = checked.nulled.reduce<Record<string, number>>((a, n) => {
      a[n.source] = (a[n.source] ?? 0) + 1
      return a
    }, {})
    console.log(
      `  seat check: dropped unresolvable seat numbers on ${checked.nulled.length} listing(s) ` +
        `(${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(' ')}) — ` +
        'those listings fall back to section-level',
    )
  }

  const { listings, collapsed, pairs } = dedupe(checked.listings)
  if (collapsed) {
    const crossSource = pairs.filter((p) => p.kept !== p.absorbed)
    console.log(
      `  dedupe: ${collapsed} listing(s) collapsed (${crossSource.length} cross-source)`,
    )
  }

  return {
    event: EVENT,
    generatedAt: new Date().toISOString(),
    sources: statuses,
    listings,
  }
}
