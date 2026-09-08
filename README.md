# Resale ticket comparison — US Open Women's Semifinals

Local-only tool that consolidates resale listings for **one** event onto a
Ticketmaster-style seat map.

    Event      US Open Women's Singles Semifinals
    Venue      Arthur Ashe Stadium (venue config 249872)
    Session    Thu Sep 10 2026, 7:00 PM
    Quantity   exactly 2 tickets together — nothing else is captured or shown
    Prices     all-in per ticket: fees included, before tax

No database, no auth, no deploy config. `localhost` only.

## Run it

```bash
npm install
npx playwright install chromium   # first time only
npm run dev                       # http://localhost:5173
```

The UI reads `captures/listings.json` if it exists and falls back to
`src/data/fixtures.json` otherwise, so it renders before any capture is run.

| command | what it does |
|---|---|
| `npm run dev` | the app |
| `npm run capture` | run every source, dedupe, write `captures/listings.json` |
| `npm run capture -- stubhub vivid` | only the matching sources (others reused from cache) |
| `npm run venue` | rebuild `src/data/venue.json` from `manifest/` |
| `npm run fixtures` | rebuild `src/data/fixtures.json` |
| `npm test` | parser unit tests |

## How it fits together

```
manifest/          Phase 0 artifacts pulled off the Ticketmaster event page.
                   See manifest/README.md for provenance and the pricing proof.
  ↓ scripts/build-venue.ts
src/data/venue.json     105 sections with SVG outlines + 21,071 seats with x/y

capture/sources/*.ts    one module per source, all `capture(): Promise<Listing[]>`
  ↓ capture/index.ts    runs them, isolates failures, dedupes
captures/by-source/*    per-source cache, so a partial run stays whole
captures/listings.json  what the UI reads
```

The UI never imports a parser. `capture/index.ts` exposes a single
`runAllCaptures()`; a future `POST /api/capture` would call that same function
and write that same file, with no change to the sources or the UI. The dev
server already serves `/captures/*` off disk (`vite.config.ts`), which is where
that endpoint would slot in.

## The map

`src/data/venue.json` and the background art share one coordinate space
(`10240 × 7680`), so seat dots overlay the venue art with no transform.

Two encodings, deliberately kept distinguishable:

- **Seat dots** — a listing that publishes seat numbers colors exactly the seats
  it names. Grey means no 2-together listing covers that seat.
- **Hatched section fill** — a listing that does *not* publish seat numbers
  tints its whole section by the cheapest such listing. No dot is ever placed
  for a seat number we don't have.

Dot radii are authored in screen pixels and converted to venue units, so they
stay legible from full-venue zoom down to individual rows.

## All-in pricing

The only price in the system is `allInPricePerTicket` — per ticket, fees in, tax
out. Pre-fee prices never leave a source adapter.

For Ticketmaster this is `listPrice + Σ charges where type === 'fee'`, *not*
`totalPrice`, which folds a `face_value_tax` charge into primary offers. Both
forms were checked against the site's own panel — see `manifest/README.md`.

## Sources

| source | method | notes |
|---|---|---|
| Ticketmaster | passive interception of its own ISM inventory API | seat-level for all inventory |
| Vivid Seats | `hermes/api/v1/listings` | mostly section+row, some seat-level |
| Ticket Liquidator | inlined TicketNetwork payload | section+row, no seat numbers |
| StubHub | real Chrome over CDP, then its own paginating grid POST | section+row, some seat-level; **needs one human click** |
| SeatGeek | **blocked** — DataDome CAPTCHA interstitial | needs a manual payload, see below |

Sources fail independently: each is loaded and run inside its own try, so a
blocked or unloadable module is recorded as that one source failing and the rest
still produce a bundle. Per-source status shows in the panel's footer.

### StubHub needs one human click

StubHub 403s the event document from plain Playwright — the page never renders,
so there is nothing to intercept. What works is driving a real Google Chrome
over CDP with a dedicated profile: a human clears the interstitial once, and
after that the grid's own `POST … {"Method":"IndexShGridOnly"}` paginates all
inventory (34 pages at quantity 2). All-in is the `estimatedFees=true` URL
param, which changes what `item.rawPrice` *means* — see the module header.

One caveat worth stating: StubHub does not itemize tax in this payload
(`formattedFees` is empty, no tax field), so unlike Ticketmaster, "pre-tax"
cannot be independently verified for this source. `rawPrice` is the
fee-inclusive number StubHub itself shows the buyer.

### SeatGeek needs one manual step

SeatGeek serves a DataDome interstitial to this machine. Solving it is out of
scope by design (no CAPTCHA solving, no proxy rotation, no fingerprint
spoofing), so it takes the documented manual path:

1. Open the event URL in your normal browser, all-in pricing **on**, quantity **2**,
   and scroll the listings panel so the full list renders.
2. DevTools → Network. Tick **"Preserve log"**, then **reload** so the listings
   request is recorded (it fires early; DevTools must already be open).
3. Filter for `event_listings_v2`, click it, right-click → **Copy → Copy response**,
   then `pbpaste > captures/raw/seatgeek.json`.
4. `npm run capture -- seatgeek`

A whole-session HAR also works at `captures/raw/seatgeek.har` — the parser scans
every response body in it and finds the listings **by shape**, so the endpoint
name doesn't matter. But note: Chrome's **"sanitized"** HAR export strips
response bodies (each entry keeps only `size` and `mimeType`), so it cannot be
parsed. Use the non-sanitized export, or just copy the single response as above.
The parser detects a sanitized HAR and says so explicitly rather than reporting
"no listings found".

A saved page at `captures/raw/seatgeek.html` is also supported, via its embedded
`__NEXT_DATA__`.

If the export was produced by a still-blocked session, the parser says so
explicitly rather than emitting nothing.

The parser is written and waiting for that file. `captures/raw/seatgeek.json`
currently holds the block evidence and these instructions, not inventory.

## Partial runs

Each source's result is cached to `captures/by-source/<source>.json`, and a run
folds in the cache for whatever it didn't re-run. This matters because dedupe
operates on the **union** of all sources: without the cache,
`npm run capture -- seatgeek` would rebuild the bundle from one source and
silently drop the other four. A source that fails supersedes its cached success,
so a stale capture is never reported as current.

## Seat numbers we don't actually have

Sources publish seat labels that don't correspond to real seats — StubHub emits
sentinel ranges like `9996-9999`, and some rows carry seat numbers copied from
the section id. `capture/lib/placeSeats.ts` runs centrally over every source's
output and keeps a listing's seat numbers only if **all** of them resolve to a
real seat in that section and row. Anything else becomes `seats: null` and falls
back to section-level tinting, so no dot is ever placed on a seat we can't
confirm exists.

Three independent sources (StubHub, Ticket Liquidator, Vivid Seats) all report a
**section 303 row P** that the Ticketmaster manifest does not contain. That's
left as-is and surfaced in the UI's "could not be placed" counter rather than
patched — the manifest is the authority for the map, and a real discrepancy is
worth seeing.

## Dedupe

Ticket Liquidator and Vivid Seats syndicate overlapping broker inventory.
Listings matching on **(section, row, all-in price within 2%)** collapse to one,
keeping the lowest price and recording every source that carried it in `alsoOn`
(surfaced as a "+N more" badge in the panel).

Published seat numbers are a veto: if two listings both name their seats and the
seats differ, they are different inventory and never collapse, however close the
price. That keeps Ticketmaster's seat-level inventory from being discarded on a
price coincidence.

## A note on access

These sites' terms prohibit automated access. This is a one-off personal tool
run by hand. Nothing here runs on a schedule, and `capture/lib/browser.ts` paces
requests deliberately — sequential sources, real viewport, jittered dwell times —
rather than hammering. There is no CAPTCHA handling, proxy rotation, or
fingerprint spoofing anywhere in the codebase; where a site blocks us, the
module says so and falls back to parsing a manually saved payload.

## Out of scope

Other events, other quantities, live refresh, purchasing, accounts, mobile.
