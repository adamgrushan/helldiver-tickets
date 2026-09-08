import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupe } from './dedupe.ts'
import type { Listing } from '../../src/types.ts'

const L = (o: Partial<Listing>): Listing => ({
  source: 'vividseats',
  sourceListingId: 'x',
  section: '313',
  row: 'A',
  seats: null,
  allInPricePerTicket: 100,
  listingUrl: '',
  capturedAt: '',
  ...o,
})

test('collapses syndicated inventory and keeps the lowest all-in price', () => {
  const { listings } = dedupe([
    L({ source: 'ticketliquidator', allInPricePerTicket: 358.0 }),
    L({ source: 'vividseats', allInPricePerTicket: 353.2 }),
  ])
  assert.equal(listings.length, 1)
  assert.equal(listings[0].allInPricePerTicket, 353.2)
  assert.deepEqual([...listings[0].alsoOn!].sort(), [
    'ticketliquidator',
    'vividseats',
  ])
})

test('leaves listings further apart than the tolerance alone', () => {
  const { listings } = dedupe([
    L({ allInPricePerTicket: 100 }),
    L({ source: 'ticketliquidator', allInPricePerTicket: 110 }),
  ])
  assert.equal(listings.length, 2)
})

test('never collapses listings whose published seats differ', () => {
  // Different seats are different inventory, however close the price.
  const { listings } = dedupe([
    L({ source: 'ticketmaster', seats: ['1', '2'], allInPricePerTicket: 200 }),
    L({ source: 'stubhub', seats: ['5', '6'], allInPricePerTicket: 201 }),
  ])
  assert.equal(listings.length, 2)
})

test('collapses matching seats at a matching price', () => {
  const { listings } = dedupe([
    L({ source: 'ticketmaster', seats: ['1', '2'], allInPricePerTicket: 200 }),
    L({ source: 'stubhub', seats: ['2', '1'], allInPricePerTicket: 201 }),
  ])
  assert.equal(listings.length, 1)
  assert.equal(listings[0].allInPricePerTicket, 200)
})

test('keeps different rows and sections apart', () => {
  assert.equal(
    dedupe([L({ row: 'A' }), L({ source: 'stubhub', row: 'B' })]).listings.length,
    2,
  )
  assert.equal(
    dedupe([L({ section: '110' }), L({ source: 'stubhub', section: '111' })]).listings
      .length,
    2,
  )
})

test('collapses a seatless listing into a seated one', () => {
  // Either could be the same physical pair; the seatless side can't disprove it.
  const { listings } = dedupe([
    L({ source: 'ticketliquidator', seats: null, allInPricePerTicket: 300 }),
    L({ source: 'vividseats', seats: ['7', '8'], allInPricePerTicket: 302 }),
  ])
  assert.equal(listings.length, 1)
  assert.equal(listings[0].allInPricePerTicket, 300)
})

test('clusters greedily from the cheapest so the result is deterministic', () => {
  const { listings, collapsed } = dedupe([
    L({ source: 'seatgeek', allInPricePerTicket: 102 }),
    L({ allInPricePerTicket: 100 }),
    L({ source: 'stubhub', allInPricePerTicket: 101 }),
  ])
  assert.equal(listings.length, 1)
  assert.equal(collapsed, 2)
  assert.equal(listings[0].allInPricePerTicket, 100)
})

test('returns listings sorted by all-in price ascending', () => {
  const { listings } = dedupe([
    L({ row: 'C', allInPricePerTicket: 500 }),
    L({ row: 'D', allInPricePerTicket: 300 }),
    L({ row: 'E', allInPricePerTicket: 400 }),
  ])
  assert.deepEqual(
    listings.map((l) => l.allInPricePerTicket),
    [300, 400, 500],
  )
})
