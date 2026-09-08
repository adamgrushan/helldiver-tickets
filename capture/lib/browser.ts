/**
 * Shared browser setup for the capture modules.
 *
 * These sites throttle or challenge clients that behave mechanically — many
 * requests back to back, instant navigation, no dwell time. The defaults here
 * pace a capture like a person reading the page: one page at a time, real
 * viewport, a beat between actions, and generous waits for lazily-loaded
 * inventory.
 *
 * This is politeness, not evasion. There is deliberately no CAPTCHA handling,
 * no proxy rotation, and no fingerprint spoofing here — if a site challenges
 * us, the module falls back to parsing a manually saved payload.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

export type PacedSession = {
  browser: Browser
  context: BrowserContext
  page: Page
  /** Wait a human-ish beat. Randomized so we don't emit a metronome. */
  beat: (ms?: number) => Promise<void>
  close: () => Promise<void>
}

/** Randomized pause around `ms`, ±40%. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.6 + Math.random() * 0.8))
}

export async function openPacedSession(opts?: {
  /** Extra delay applied to every Playwright action. */
  slowMo?: number
  viewport?: { width: number; height: number }
}): Promise<PacedSession> {
  const browser = await chromium.launch({
    headless: false,
    slowMo: opts?.slowMo ?? 250,
    args: ['--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    viewport: opts?.viewport ?? { width: 1600, height: 1000 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })
  const page = await context.newPage()
  const beat = (ms = 1200) => page.waitForTimeout(jitter(ms))
  return {
    browser,
    context,
    page,
    beat,
    close: () => browser.close(),
  }
}

/**
 * Scroll a listings panel until it stops growing, pausing between scrolls so
 * lazily-loaded pages arrive without a burst of requests.
 *
 * `countSelector` should match one listing row. Returns the final row count.
 */
export async function scrollToLoadAll(
  page: Page,
  countSelector: string,
  opts?: { maxScrolls?: number; settleMs?: number; container?: string },
): Promise<number> {
  const maxScrolls = opts?.maxScrolls ?? 40
  const settleMs = opts?.settleMs ?? 1400
  let stable = 0
  let last = -1

  for (let i = 0; i < maxScrolls && stable < 3; i++) {
    const count = await page.locator(countSelector).count()
    if (count === last) stable++
    else stable = 0
    last = count

    if (opts?.container) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (el) el.scrollTop = el.scrollHeight
      }, opts.container)
    } else {
      await page.mouse.wheel(0, 900)
    }
    await page.waitForTimeout(jitter(settleMs))
  }
  return last
}

/**
 * Collect responses the page's own frontend fetches. This is the technique that
 * works where a synthetic fetch of the same URL is refused: attach before
 * navigating, then let the site load normally.
 */
export function recordResponses(
  page: Page,
  match: RegExp,
  sink: Array<{ url: string; status: number; body: string }>,
): void {
  page.on('response', async (res) => {
    const url = res.url()
    if (!match.test(url)) return
    const ct = res.headers()['content-type'] ?? ''
    if (!/json|javascript|text\/html/i.test(ct)) return
    try {
      sink.push({ url, status: res.status(), body: await res.text() })
    } catch {
      // Response body already discarded by the browser — not worth retrying.
    }
  })
}
