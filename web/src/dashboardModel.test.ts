import { describe, expect, it } from 'vitest'
import { BUDGET_DEFAULTS } from '@upstream/shared/budget'
import {
  advanceDemo,
  demoAt,
  demoTally,
  DEMO_STEPS,
  emptyDemo,
  transactionUrl,
  type Activity
} from './dashboardModel'

describe('frontend rehearsal accounting', () => {
  it('counts Lisa as one owner across multiple tool calls', () => {
    const tally = demoTally(demoAt(5))
    expect(tally.owners).toBe(1)
    expect(tally.contributions).toBe(5)
    expect(tally.totalMatched).toBe(0)
  })
  it('gives the crowd matching while the lone whale only contributes directly', () => {
    const tally = demoTally(demoAt(46))
    expect(tally.rows.find((r) => r.project === 'tiny-tls')).toMatchObject({
      supporters: 1,
      raised: BUDGET_DEFAULTS.whaleContributionSats,
      match: 0
    })
    expect(
      tally.rows.find((r) => r.project === 'stream-utils')!.match
    ).toBeGreaterThan(0)
    expect(tally.totalMatched).toBeLessThanOrEqual(tally.pool)
  })
  it('keeps rejected agents out of raised funds, owners and matching', () => {
    const before = demoTally(demoAt(52))
    const after = demoTally(demoAt(DEMO_STEPS))
    expect(after.rejected).toBe(10)
    expect(after.rows).toEqual(before.rows)
    expect(after.totalRaised).toBe(before.totalRaised)
    expect(after.owners).toBe(before.owners)
    expect(after.contributions).toBe(before.contributions)
  })
  it('recomputes matching for a changed pool without inventing contributions', () => {
    const state = demoAt(45)
    const doubled = demoTally({ ...state, pool: state.pool * 2 })
    const zero = demoTally({ ...state, pool: 0 })
    expect(doubled.totalMatched).toBeGreaterThan(demoTally(state).totalMatched)
    expect(zero.totalMatched).toBe(0)
    expect(zero.contributions).toBe(45)
  })
  it('stops at the end, bounds activity, and resets without any network receipts', () => {
    const complete = demoAt(DEMO_STEPS)
    expect(advanceDemo(complete)).toBe(complete)
    expect(complete.feed.length).toBeLessThanOrEqual(30)
    expect(complete.feed.every((e) => e.dryRun && !e.txid)).toBe(true)
    expect(demoTally(emptyDemo()).contributions).toBe(0)
  })
})
describe('blockchain receipt links', () => {
  const receipt: Activity = {
    id: 'test',
    project: 'tiny-tls',
    label: 'Agent',
    sats: 10,
    source: 'swarm',
    dryRun: false,
    txid: 'a'.repeat(64)
  }
  it('links only valid reported broadcasts', () => {
    expect(transactionUrl(receipt)).toBe(
      `https://whatsonchain.com/tx/${receipt.txid}`
    )
    expect(transactionUrl({ ...receipt, dryRun: true })).toBeNull()
    expect(transactionUrl({ ...receipt, source: 'rejected' })).toBeNull()
    expect(transactionUrl({ ...receipt, txid: 'not-a-transaction' })).toBeNull()
    expect(transactionUrl({ ...receipt, txid: undefined })).toBeNull()
  })
})
