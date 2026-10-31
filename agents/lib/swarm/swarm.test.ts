import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { signAgentAttestation } from '@upstream/shared/attestation'
import { loadBudget } from '@upstream/shared/budget'
import { loadRuntime } from '@upstream/shared/runtime'
import type { KeyRecord, KeyStore } from '@upstream/shared/keystore'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-swarm-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterAll(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

const { loadSwarmConfig, parseDelay, drawDelay } = await import('./config.ts')
const { stackFor, pickTool, seededRandom, TOOL_PROFILES } = await import('./usage.ts')
const { runSwarm } = await import('./runner.ts')
const { contribute, ContributeError } = await import('../contribute.ts')
const { seedSyntheticFunding, writeUtxos, getUtxo } = await import('../utxos.ts')
const { verifyContribution, ContributionError } = await import('../../../server/src/contributions.ts')

const ROUND = 'round-1'
const budget = loadBudget({ SWARM_SIZE: '3', SYBIL_SIZE: '2' })
const runtime = loadRuntime({ DRY_RUN: 'true', SERVER_URL: 'http://swarm.test', ROUND })

const key = (label: string): KeyRecord => {
  const priv = PrivateKey.fromRandom()
  return {
    label,
    privHex: priv.toHex(),
    wif: priv.toWif([0x80]),
    pubKey: priv.toPublicKey().toString(),
    address: priv.toAddress([0x00])
  }
}

const keys: KeyStore = {
  projects: [],
  lisa: key('lisa-agent'),
  swarm: [1, 2, 3].map(i => ({ agent: key(`swarm-agent-00${i}`), owner: key(`swarm-owner-00${i}`) })),
  whale: { agent: key('whale-agent'), owner: key('whale-owner') },
  sybil: [key('sybil-agent-001'), key('sybil-agent-002')]
}

/**
 * Route `POST /contribution` straight into the server's real verifier, so
 * these tests exercise the same accept/reject decision the tally makes.
 */
function serveWithRealVerifier(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const report = JSON.parse(String(init?.body))
    try {
      const stored = await verifyContribution(report, { round: ROUND, budget })
      return new Response(JSON.stringify(stored), { status: 200 })
    } catch (err) {
      if (!(err instanceof ContributionError)) throw err
      return new Response(JSON.stringify({ error: err.message }), { status: 422 })
    }
  })
}

beforeEach(() => {
  writeUtxos({})
  seedSyntheticFunding(keys, budget)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('swarm config', () => {
  it('defaults to 120 s and 500-2000 ms', () => {
    expect(loadSwarmConfig({})).toEqual({ durationSec: 120, delayMinMs: 500, delayMaxMs: 2000 })
  })

  it('reads SWARM_DURATION_SEC and SWARM_DELAY_MS from env', () => {
    expect(loadSwarmConfig({ SWARM_DURATION_SEC: '30', SWARM_DELAY_MS: '100-200' })).toEqual({
      durationSec: 30,
      delayMinMs: 100,
      delayMaxMs: 200
    })
    expect(parseDelay('750')).toEqual({ delayMinMs: 750, delayMaxMs: 750 })
  })

  it('lets CLI flags override env (swarm:demo uses --duration 60)', () => {
    const c = loadSwarmConfig({ SWARM_DURATION_SEC: '300' }, ['--duration', '60', '--delay=10-20'])
    expect(c).toEqual({ durationSec: 60, delayMinMs: 10, delayMaxMs: 20 })
  })

  it('refuses nonsense', () => {
    expect(() => loadSwarmConfig({ SWARM_DURATION_SEC: '1.5' })).toThrow(/SWARM_DURATION_SEC/)
    expect(() => parseDelay('2000-500')).toThrow(/minimum/)
    expect(() => parseDelay('a-b')).toThrow(/SWARM_DELAY_MS/)
  })

  it('draws delays inside the range', () => {
    const c = { durationSec: 1, delayMinMs: 500, delayMaxMs: 2000 }
    const rand = seededRandom(1)
    for (let i = 0; i < 500; i++) {
      const d = drawDelay(c, rand)
      expect(d).toBeGreaterThanOrEqual(500)
      expect(d).toBeLessThanOrEqual(2000)
    }
  })
})

describe('usage weighting', () => {
  const labels = Array.from({ length: 50 }, (_, i) => `swarm-agent-${String(i + 1).padStart(3, '0')}`)

  it('gives the small libraries most of the supporters', () => {
    const count = new Map<string, number>()
    for (const l of labels) for (const t of stackFor(l)) count.set(t.projectId, (count.get(t.projectId) ?? 0) + 1)
    const small = Math.min(count.get('stream-utils') ?? 0, count.get('compress-lite') ?? 0)
    const others = ['color-text', 'log-helper', 'tiny-tls'].map(p => count.get(p) ?? 0)
    expect(small).toBeGreaterThan(35)
    for (const o of others) expect(small).toBeGreaterThan(o)
  })

  it('is stable per agent and never empty', () => {
    for (const l of labels) {
      expect(stackFor(l)).toEqual(stackFor(l))
      expect(stackFor(l).length).toBeGreaterThan(0)
    }
  })

  it('picks the small libraries most often', () => {
    const rand = seededRandom(7)
    const hits = new Map<string, number>()
    for (let i = 0; i < 10_000; i++) {
      const p = pickTool(TOOL_PROFILES, rand).projectId
      hits.set(p, (hits.get(p) ?? 0) + 1)
    }
    const small = (hits.get('stream-utils') ?? 0) + (hits.get('compress-lite') ?? 0)
    expect(small / 10_000).toBeGreaterThan(0.6)
  })
})

describe('runSwarm', () => {
  const agents = async () =>
    await Promise.all(
      keys.swarm.map(async p => ({
        label: p.agent.label,
        key: PrivateKey.fromHex(p.agent.privHex),
        attestation: await signAgentAttestation(
          new ProtoWallet(PrivateKey.fromHex(p.owner.privHex)),
          p.agent.pubKey
        )
      }))
    )

  it('runs every agent in parallel and every contribution is counted by the real verifier', async () => {
    serveWithRealVerifier()
    const stats = await runSwarm({
      agents: await agents(),
      config: { durationSec: 1, delayMinMs: 10, delayMaxMs: 30 },
      budget,
      runtime
    })
    expect(stats.txs).toBeGreaterThan(10)
    expect(stats.rejected).toBe(0)
    expect(stats.errors).toBe(0)
    expect(stats.accepted).toBe(stats.txs)
    // each agent chained its change: balance went down
    for (const p of keys.swarm) {
      expect(getUtxo(p.agent.label)!.satoshis).toBeLessThan(budget.fundSwarmAgentSats)
    }
  })

  it('retires an agent that runs out of money instead of crashing', async () => {
    let calls = 0
    const stats = await runSwarm({
      agents: (await agents()).slice(0, 1),
      config: { durationSec: 5, delayMinMs: 1, delayMaxMs: 1 },
      budget,
      runtime,
      contribute: async () => {
        calls++
        if (calls > 3) throw new ContributeError('swarm-agent-001 holds 5 sats, not enough to pay 10 plus a fee.')
        return { accepted: true, sats: 10, fee: 1 } as Awaited<ReturnType<typeof contribute>>
      }
    })
    expect(stats.txs).toBe(3)
    expect(stats.retired).toBe(1)
    expect(stats.elapsedMs).toBeLessThan(4_000)
  })

  it('stops promptly when aborted', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const stats = await runSwarm({
      agents: await agents(),
      config: { durationSec: 60, delayMinMs: 1_000, delayMaxMs: 1_000 },
      budget,
      runtime,
      signal: controller.signal,
      contribute: async () => ({ accepted: true, sats: 10, fee: 1 }) as Awaited<ReturnType<typeof contribute>>
    })
    expect(stats.elapsedMs).toBeLessThan(2_000)
  })
})

describe('whale and sybil against the real verifier', () => {
  it('the whale lands as one large contribution from one owner', async () => {
    serveWithRealVerifier()
    const r = await contribute(
      {
        agentLabel: keys.whale.agent.label,
        agentKey: PrivateKey.fromHex(keys.whale.agent.privHex),
        projectId: 'tiny-tls',
        sats: budget.whaleContributionSats,
        owner: PrivateKey.fromHex(keys.whale.owner.privHex)
      },
      { budget, runtime }
    )
    expect(r.accepted).toBe(true)
    expect(r.sats).toBe(budget.whaleContributionSats)
  })

  it('every sybil (no owner, fake project) is rejected', async () => {
    serveWithRealVerifier()
    for (const s of keys.sybil) {
      const r = await contribute(
        { agentLabel: s.label, agentKey: PrivateKey.fromHex(s.privHex), projectId: 'totally-legit' },
        { budget, runtime }
      )
      expect(r.accepted).toBe(false)
      expect(r.serverMessage).toMatch(/unknown project|owner/)
    }
  })

  it('a sybil is still rejected for having no owner, even on a real project', async () => {
    serveWithRealVerifier()
    const s = keys.sybil[0]!
    const r = await contribute(
      { agentLabel: s.label, agentKey: PrivateKey.fromHex(s.privHex), projectId: 'stream-utils' },
      { budget, runtime }
    )
    expect(r.accepted).toBe(false)
    expect(r.serverMessage).toMatch(/owner/)
  })
})
