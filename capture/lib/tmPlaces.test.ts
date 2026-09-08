import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expandPlaces, expandAll } from './tmPlaces.ts'

const sorted = (a: string[]) => [...a].sort()

test('expands a flat bracket group', () => {
  assert.deepEqual(sorted(expandPlaces('GEYDAQR2IE5D[C,E]')), [
    'GEYDAQR2IE5DC',
    'GEYDAQR2IE5DE',
  ])
})

test('passes an uncompressed id through unchanged', () => {
  assert.deepEqual(expandPlaces('GEYDEOSMHIYTC'), ['GEYDEOSMHIYTC'])
})

test('expands nested groups to any depth', () => {
  assert.deepEqual(sorted(expandPlaces('GEYDCOSHHI[2[A,Q],3A,YQ,Z[A,Q]]')), [
    'GEYDCOSHHI2A',
    'GEYDCOSHHI2Q',
    'GEYDCOSHHI3A',
    'GEYDCOSHHIYQ',
    'GEYDCOSHHIZA',
    'GEYDCOSHHIZQ',
  ])
})

test('takes the cross product of sibling groups', () => {
  assert.deepEqual(sorted(expandPlaces('A[B,C]D[E,F]')), [
    'ABDE',
    'ABDF',
    'ACDE',
    'ACDF',
  ])
})

test('returns nothing for unbalanced brackets rather than guessing', () => {
  // A partial expansion would put a dot on the wrong seat.
  assert.deepEqual(expandPlaces('unbalanced[A,B'), [])
  assert.deepEqual(expandPlaces('A]B'), [])
})

test('expandAll dedupes across place strings', () => {
  assert.deepEqual(sorted(expandAll(['A[B,C]', 'AB'])), ['AB', 'AC'])
  assert.deepEqual(expandAll(undefined), [])
})

/**
 * The strongest available check on the parser: every facet in the real capture
 * declares how many places it holds, and the expansion must produce exactly
 * that many ids — all of which must exist in the venue manifest.
 */
test('real capture: expanded counts match every facet\'s declared count', () => {
  const raw = JSON.parse(readFileSync('captures/raw/ticketmaster.json', 'utf8'))
  const venue = JSON.parse(readFileSync('src/data/venue.json', 'utf8'))
  const known = new Set<string>(
    venue.sections.flatMap((s: { seats: Array<{ seatId: string }> }) =>
      s.seats.map((st) => st.seatId),
    ),
  )

  let checked = 0
  for (const facet of raw.facets) {
    if (typeof facet.count !== 'number') continue
    const ids = expandAll(facet.places)
    assert.equal(
      ids.length,
      facet.count,
      `facet ${facet.section} declared ${facet.count} places, expanded to ${ids.length}`,
    )
    for (const id of ids) {
      assert.ok(known.has(id), `place ${id} is not in the venue manifest`)
    }
    checked++
  }
  assert.ok(checked > 500, `expected to check many facets, checked ${checked}`)
})
