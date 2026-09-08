# Capture module contract

One module per source in `capture/sources/<source>.ts`. Each exports exactly:

```ts
import type { Listing } from '../../src/types.ts'
export async function capture(): Promise<Listing[]>
```

Rules every module follows:

1. **No top-level side effects.** Importing the module must not open a browser or
   read a file. All work happens inside `capture()`. This is what lets the same
   function later sit behind a local HTTP endpoint without restructuring.
2. **Sources fail independently.** Throw on failure; the orchestrator catches and
   records `status: 'failed'` for that source only.
3. **Exactly 2 together.** Only emit listings actually purchasable as a pair. If
   the source exposes a quantity/split filter, set it to 2 and additionally
   verify per listing — a `quantity=2` URL param is not always honored.
4. **All-in, pre-tax, per ticket.** `allInPricePerTicket` includes fees, excludes
   tax. Turn the site's all-in/"total price" mode on before capture (URL param,
   setting, or toggle click) and assert it took effect. A pre-fee price must never
   be written to a `Listing`.
5. **Normalize sections.** Run every section label through `normalizeSection()`
   from `../lib/normalize.ts`. The result must be one of the ids in
   `capture/lib/venue-vocab.json` — anything else gets reported, not silently
   emitted with a section the map can't place.
6. **`seats: null` is correct** when the source doesn't publish seat numbers.
   Never invent or infer seat numbers.
7. **Save the raw payload** to `captures/raw/<source>.json` (or `.html`) and
   prefer parsing that file, so a capture is reproducible without a live fetch.

## Access approach — in order of preference

1. **The JSON endpoint the site's own frontend calls.** Best: structured, fast,
   seat-level where it exists.
2. **Headed Playwright, DOM parsed**, listings panel scrolled to load all
   inventory.
3. **Manual**: the user loads the page and saves the response to
   `captures/raw/<source>.json|html`; the module parses that file. For a one-time
   pull this is a legitimate outcome, not a failure.

**Passive interception is the technique that worked on Ticketmaster** and should
be tried first: load the page in Playwright, attach a `response` listener, and
record what the site's own frontend fetches. Direct server-side `fetch()` of
those same endpoints returns 403, and synthetic in-page `fetch()` is blocked by
the bot-detection wrapper — but simply *watching* the page's own traffic works.

Do **not** attempt CAPTCHA solving, proxy rotation, or fingerprint spoofing. If a
site blocks everything, fall back to option 3 and say so.
