# Phase 0 — venue manifest provenance

Captured by `node scripts/phase0/network-log.mjs <ticketmaster event url>`, which
opens the event page in headed Playwright and records every network response
matching map/seat/inventory patterns. Full log in `_netlog/`.

Event: US Open Women's Singles Semifinals — Arthur Ashe Stadium
Thu Sep 10 2026, 7pm session · Ticketmaster event id `1D00646DB471672F`
Venue config `249872` (venue `237621-249872`)

## Files

| file | source URL | what it carries |
|---|---|---|
| `tm-placeDetailNoKeys.json` | `mapsapi.tmol.io/maps/geometry/3/event/1D00646DB471672F/placeDetailNoKeys?useHostGrids=true&app=PRD2663_EDP_NA&sectionLevel=true&systemId=HOST` | **the manifest.** 105 sections with SVG path outlines + 21,071 seats with x/y |
| `tm-venue-map.svg` | `mapsapi.tmol.io/maps/geometry/image/80/39/803987?removeFilters=ISM_Shadow&avertaFonts=true&app=PRD2663_EDP_NA` | background art (structure, court, masks) |
| `tm-inventory-facets.json` | `offeradapter.ticketmaster.com/api/ismds/event/1D00646DB471672F/facets?by=inventorytypes+offer&q=available&show=...` | **what it costs.** 851 offers with prices, seats, sellable quantities |
| `tm-facets-by-section.json` | `services.ticketmaster.com/api/ismds/event/1D00646DB471672F/facets?by=section+seating+...+offer+...&q=available&show=places&compress=places` | **where it is.** 859 facets pairing each offer with a section + its place ids |
| `tm-quickpicks-qty2.json` | `offeradapter.ticketmaster.com/api/ismds/event/1D00646DB471672F/quickpicks?...&qty=2` | the page's own qty=2 recommendations |
| `tm-static-manifest.json` | `pubapi.ticketmaster.com/sdk/static/manifest/v1/1D00646DB471672F` | static section/row vocabulary (unused; superseded by the above) |

## Coordinate space

`placeDetailNoKeys.pages[0]` is `10240 x 7680`, and `tm-venue-map.svg` has
`viewBox="0 0 10240 7680"`. Seat x/y, section paths, and the background art all
share one space — seat dots overlay the art with no transform.

`placesNoKeys` entries are positional tuples, not objects:

    [placeId, seatLabel, x, y, gridBand, colIndex, rowIndex]

## The two-response join

Inventory needs both facet responses, joined on `offerId`:

- `tm-facets-by-section.json` says **where** — `{ section, offers[], places[], count }`
- `tm-inventory-facets.json` says **what it costs** — `_embedded.offer[]`

The join is not optional. Resale offers happen to carry their own
`section`/`row`/`seatFrom`/`seatTo`, but **primary ("Standard Ticket") offers
carry none of that** — only a `priceLevelId`. Without the by-section response
they cannot be placed at all, and those are exactly the featured rows the site's
own panel leads with. Dropping them silently loses the $1,409 Sec 116 / 110 /
122 rows visible in the reference screenshot.

848 of 851 offers join; the 3 that don't were captured moments apart from the
other response, and are counted as `noPrice` drops rather than guessed at.

## Compressed place ids

`places` is a nested prefix trie, not a flat list:

    "GEYDAQR2IE5D[C,E]"           -> GEYDAQR2IE5DC, GEYDAQR2IE5DE
    "GEYDCOSHHI[2[A,Q],3A,YQ]"    -> GEYDCOSHHI2A, GEYDCOSHHI2Q,
                                     GEYDCOSHHI3A, GEYDCOSHHIYQ

Expanded by `capture/lib/tmPlaces.ts`. These ids **are** the geometry manifest's
`seatId`s, which is what makes exact seat resolution possible.

Validated against the real capture: 2,357 place ids expand from 859 facets,
**100% join** to the manifest, **zero** section disagreements, and every facet's
expanded count exactly equals its own declared `count` — see the integration
test in `capture/lib/tmPlaces.test.ts`.

## Section vocabulary

Three spellings of the same section appear across the sources:

| where | spelling |
|---|---|
| geometry manifest (`segment.name`) | `100 B` |
| inventory API (`offer.section`) | `100B` |
| background SVG (`id`) | `100B` |

Canonical id = uppercase, separators stripped (`capture/lib/normalize.ts`).
All 96 sections that carry inventory reconcile to a geometry section under that
rule; 9 geometry sections have no inventory for this event.

## All-in pricing — verified

Offers carry both a pre-fee and a total price, plus an itemized `charges` array:

```json
{ "listPrice": 240, "totalPrice": 279.6,
  "charges": [{ "reason": "service", "type": "fee", "amount": 39.6 }],
  "sellableQuantities": [2], "section": "318", "row": "U",
  "seatFrom": "23", "seatTo": "24", "listingId": "1261747487" }
```

**all-in per ticket (fees in, pre-tax) = `listPrice + Σ charges where type === 'fee'`**

Do not use `totalPrice` directly: primary offers fold a `face_value_tax` charge
into it. Both forms were checked against the reference screenshot:

| offer | listPrice | fees | tax | formula | screenshot |
|---|---|---|---|---|---|
| primary `GJ6DC7BVHA` | 1374 | 35 | 122.01 | **1409.00** | Sec 116 Row Q — $1,409.00 ✓ |
| resale sec 318 row U | 240 | 39.60 | 0 | **279.60** | Sec 318 Row U — $279.60 ✓ |

`totalPrice` would have printed $1,531.01 for the first row — wrong.

## Access note

`offeradapter`/`services.ticketmaster.com` reject direct server-side fetches
(`403 {"response":"dynamic_block"}`), and the page's own `fetch` is wrapped by
Akamai bot detection, so synthetic in-page calls fail too. The working approach
is **passive**: load the page normally and record the responses its own frontend
produces. That is what the capture module does — no evasion, no spoofing.
