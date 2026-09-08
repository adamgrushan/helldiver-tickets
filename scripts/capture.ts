/**
 * CLI: run every source and write the bundle the UI reads.
 *
 *   node scripts/capture.ts                 all sources
 *   node scripts/capture.ts stubhub vivid   only matching sources
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { runAllCaptures } from '../capture/index.ts'
import { SOURCES, type Source } from '../src/types.ts'

const args = process.argv.slice(2)
const only = args.length
  ? SOURCES.filter((s) => args.some((a) => s.includes(a.toLowerCase())))
  : undefined

if (args.length && !only?.length) {
  console.error(`no source matches ${args.join(' ')}; known: ${SOURCES.join(', ')}`)
  process.exit(1)
}

console.log(`Capturing ${(only ?? SOURCES).join(', ')} at quantity 2...\n`)
const bundle = await runAllCaptures({ only: only as Source[] | undefined })

mkdirSync('captures', { recursive: true })
writeFileSync('captures/listings.json', JSON.stringify(bundle, null, 1))

const ok = bundle.sources.filter((s) => s.status === 'ok')
console.log(`\ncaptures/listings.json — ${bundle.listings.length} listings after dedupe`)
console.log(`  ${ok.length}/${bundle.sources.length} sources ok`)
for (const s of bundle.sources) {
  console.log(
    `  ${s.status === 'ok' ? '✓' : '✗'} ${s.source.padEnd(18)} ${
      s.status === 'ok' ? `${s.listingCount} listings (${s.method})` : s.error
    }`,
  )
}
