import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { loadBudget } from '@upstream/shared/budget'
import type { KeyStore } from '@upstream/shared/keystore'
import type { FundingTarget } from '@upstream/shared/funding'
import { fundingTargets, resolveOutputs, totalSats } from './funding.ts'

const MAINNET = [0x00]

const key = (label: string) => {
  const priv = PrivateKey.fromRandom()
  return {
    label,
    privHex: priv.toHex(),
    wif: priv.toWif([0x80]),
    pubKey: priv.toPublicKey().toString(),
    address: priv.toAddress(MAINNET)
  }
}

/** A key store shaped like the real one, with 3 swarm agents and 2 sybils. */
const fakeKeys = (): KeyStore => ({
  projects: [key('tiny-tls')],
  lisa: key('lisa-agent'),
  swarm: [1, 2, 3].map(i => ({ agent: key(`swarm-agent-00${i}`), owner: key(`swarm-owner-00${i}`) })),
  whale: { agent: key('whale-agent'), owner: key('whale-owner') },
  sybil: [1, 2].map(i => key(`sybil-agent-00${i}`))
})

const budget = loadBudget({ SWARM_SIZE: '3', SYBIL_SIZE: '2' })

/** Build a transaction paying each target, optionally shuffled, plus change. */
function txPaying(targets: FundingTarget[], opts: { change?: boolean; shuffle?: boolean } = {}) {
  const tx = new Transaction()
  const outs = [...targets]
  if (opts.shuffle === true) outs.reverse()
  for (const t of outs) {
    tx.addOutput({ lockingScript: new P2PKH().lock(t.address), satoshis: t.satoshis })
  }
  if (opts.change === true) {
    tx.addOutput({ lockingScript: new P2PKH().lock(key('change').address), satoshis: 4_242 })
  }
  return tx
}

describe('funding plan', () => {
  it('funds only Lisa at scope "lisa"', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'lisa')
    expect(targets).toHaveLength(1)
    expect(targets[0]!.kind).toBe('lisa')
    expect(targets[0]!.satoshis).toBe(budget.fundLisaSats)
    expect(totalSats(targets)).toBe(5_000)
  })

  it('funds every agent at scope "all", at the budget amounts', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'all')
    // 1 Lisa + 3 swarm + 1 whale + 2 sybil
    expect(targets).toHaveLength(7)
    expect(targets.filter(t => t.kind === 'swarm')).toHaveLength(3)
    expect(targets.filter(t => t.kind === 'sybil')).toHaveLength(2)
    expect(totalSats(targets)).toBe(5_000 + 3 * 1_500 + 20_000 + 2 * 200)
    for (const t of targets) expect(t.address, t.label).toMatch(/^1/)
  })

  it('never includes a project address — projects are paid by agents, not the sponsor', () => {
    const keys = fakeKeys()
    const addresses = fundingTargets(keys, budget, 'all').map(t => t.address)
    for (const p of keys.projects) expect(addresses).not.toContain(p.address)
  })

  it('never exposes private key material in the plan', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'all')
    for (const t of targets) {
      expect(Object.keys(t).sort()).toEqual(['address', 'kind', 'label', 'satoshis'])
    }
  })
})

describe('resolveOutputs', () => {
  it('maps each agent to its output index', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'all')
    const resolved = resolveOutputs(txPaying(targets), targets)
    expect(resolved.map(o => o.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(resolved.map(o => o.label)).toEqual(targets.map(t => t.label))
  })

  it('finds indexes by locking script, not by position', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'all')
    // The wallet reordered the outputs; the map must still be correct.
    const resolved = resolveOutputs(txPaying(targets, { shuffle: true }), targets)
    for (const o of resolved) {
      const want = targets.find(t => t.label === o.label)!
      expect(o.address).toBe(want.address)
      expect(o.satoshis).toBe(want.satoshis)
    }
    expect(new Set(resolved.map(o => o.index)).size).toBe(targets.length)
  })

  it('ignores the wallet change output', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'all')
    const resolved = resolveOutputs(txPaying(targets, { change: true }), targets)
    expect(resolved).toHaveLength(targets.length)
    expect(resolved.every(o => o.index < targets.length)).toBe(true)
  })

  it('does not assume index 0 belongs to the first target', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'lisa')
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(key('someone else').address), satoshis: 777 })
    tx.addOutput({ lockingScript: new P2PKH().lock(targets[0]!.address), satoshis: 5_000 })
    expect(resolveOutputs(tx, targets)[0]!.index).toBe(1)
  })

  it('throws when an agent was not paid at all', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'all')
    const tx = txPaying(targets.slice(0, -1))
    expect(() => resolveOutputs(tx, targets)).toThrow(/no output paying sybil-agent-002/)
  })

  it('throws when an output pays the wrong amount', () => {
    const targets = fundingTargets(fakeKeys(), budget, 'lisa')
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(targets[0]!.address), satoshis: 4_999 })
    expect(() => resolveOutputs(tx, targets)).toThrow(/pays lisa-agent 4999 sats, expected 5000/)
  })

  it('does not match two targets to the same output', () => {
    // Two agents sharing an address would be a key-generation bug; one output
    // must not satisfy both targets.
    const shared = key('twin')
    const targets: FundingTarget[] = [
      { label: 'a', kind: 'swarm', address: shared.address, satoshis: 1_500 },
      { label: 'b', kind: 'swarm', address: shared.address, satoshis: 1_500 }
    ]
    const one = new Transaction()
    one.addOutput({ lockingScript: new P2PKH().lock(shared.address), satoshis: 1_500 })
    expect(() => resolveOutputs(one, targets)).toThrow(/no output paying b/)

    const two = txPaying(targets)
    expect(resolveOutputs(two, targets).map(o => o.index)).toEqual([0, 1])
  })
})
