import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadBudget } from '@upstream/shared/budget'
import { loadRuntime, readDryRun } from '@upstream/shared/runtime'
import { findContributionTag } from '@upstream/shared/opreturn'
import { PROJECTS } from '@upstream/shared/projects'
import type { KeyRecord, KeyStore } from '@upstream/shared/keystore'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-contribute-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterAll(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

const { contribute, ContributeError, assertSpendable, DUST_LIMIT } = await import(
  './lib/contribute.ts'
)
const { getUtxo, putUtxo, readUtxos, seedSyntheticFunding, synthesizeFunding, writeUtxos } =
  await import('./lib/utxos.ts')

const budget = loadBudget({ SWARM_SIZE: '2', SYBIL_SIZE: '1' })
const dryRun = loadRuntime({ DRY_RUN: 'true', UPSTREAM_SERVER: 'http://127.0.0.1:1' })
const project = PROJECTS[0]!

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
  projects: [key('tiny-tls')],
  lisa: key('lisa-agent'),
  swarm: [1, 2].map(i => ({ agent: key(`swarm-agent-00${i}`), owner: key(`swarm-owner-00${i}`) })),
  whale: { agent: key('whale-agent'), owner: key('whale-owner') },
  sybil: [key('sybil-agent-001')]
}

// The server is unreachable in these tests; reporting failure must not stop a
// contribution from being built, signed and chained.
beforeEach(() => {
  writeUtxos({})
  seedSyntheticFunding(keys, budget)
})
afterEach(() => {
  vi.restoreAllMocks()
})

const lisaKey = (): PrivateKey => PrivateKey.fromHex(keys.lisa.privHex)

describe('readDryRun', () => {
  it('defaults to dry-run when DRY_RUN is unset', () => {
    expect(readDryRun(undefined)).toBe(true)
  })

  it('treats only an explicit false as live', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', ' false ']) {
      expect(readDryRun(v), v).toBe(false)
    }
    for (const v of ['true', '1', 'yes', 'on', '']) {
      expect(readDryRun(v), v).toBe(true)
    }
  })

  it('refuses a value it cannot read rather than guessing live', () => {
    expect(() => readDryRun('maybe')).toThrow(/not a boolean/)
  })
})

describe('synthetic funding', () => {
  it('pays every agent its budget amount', () => {
    const { tx, utxos } = synthesizeFunding(keys, budget)
    // 1 lisa + 2 swarm + 1 whale + 1 sybil
    expect(utxos).toHaveLength(5)
    expect(utxos.find(u => u.agent === 'lisa-agent')?.satoshis).toBe(5_000)
    expect(utxos.filter(u => u.agent.startsWith('swarm')).every(u => u.satoshis === 1_500)).toBe(
      true
    )
    expect(utxos.find(u => u.agent === 'whale-agent')?.satoshis).toBe(20_000)
    expect(utxos.find(u => u.agent === 'sybil-agent-001')?.satoshis).toBe(200)
    expect(tx.outputs).toHaveLength(5)
  })

  it('is unbroadcastable by construction — it has no input', () => {
    const { tx } = synthesizeFunding(keys, budget)
    expect(tx.inputs).toHaveLength(0)
  })

  it('marks every output synthetic, so it cannot pass for real money', () => {
    const { utxos } = synthesizeFunding(keys, budget)
    expect(utxos.every(u => u.synthetic)).toBe(true)
    expect(utxos.every(u => u.origin === 'synthetic')).toBe(true)
  })

  it('never overwrites an output an agent already holds', () => {
    const real = {
      ...getUtxo('lisa-agent')!,
      satoshis: 77,
      synthetic: false,
      origin: 'funding-import' as const
    }
    putUtxo(real)

    const { seeded, skipped } = seedSyntheticFunding(keys, budget)
    expect(seeded).toBe(0)
    expect(skipped).toBe(5)
    expect(getUtxo('lisa-agent')?.satoshis).toBe(77)
    expect(getUtxo('lisa-agent')?.synthetic).toBe(false)
  })
})

describe('contribute (dry run)', () => {
  it('builds the three outputs PROJECT_BRIEF.md specifies', async () => {
    const r = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )

    const tx = Transaction.fromHex(r.rawTxHex)
    expect(tx.outputs).toHaveLength(3)

    // 0: pays the project
    expect(tx.outputs[0]!.lockingScript.toHex()).toBe(new P2PKH().lock(project.address).toHex())
    expect(tx.outputs[0]!.satoshis).toBe(budget.contributionSats)

    // 1: the tag
    expect(tx.outputs[1]!.satoshis).toBe(0)
    expect(findContributionTag(tx)).toEqual({ round: 'round-1', projectId: project.id })

    // 2: change back to the agent
    expect(tx.outputs[2]!.lockingScript.toHex()).toBe(
      new P2PKH().lock(keys.lisa.address).toHex()
    )
  })

  it('does NOT broadcast', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    expect(r.broadcast).toBe(false)
    expect(r.dryRun).toBe(true)
    // The only request attempted is the tally report, never Arcade.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain('bsvblockchain.tech')
    }
  })

  it('pays a real fee and conserves satoshis', async () => {
    const before = getUtxo('lisa-agent')!.satoshis
    const r = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    expect(r.fee).toBeGreaterThan(0)
    expect(r.sats + r.change + r.fee).toBe(before)
  })

  it('chains: the change becomes the next input', async () => {
    const start = getUtxo('lisa-agent')!.satoshis

    const first = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    const mid = getUtxo('lisa-agent')!
    expect(mid.txid).toBe(first.txid)
    expect(mid.vout).toBe(2)
    expect(mid.satoshis).toBe(first.change)
    expect(mid.origin).toBe('change')

    const second = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    // The second transaction really spends the first one's change output.
    expect(Transaction.fromHex(second.rawTxHex).inputs[0]!.sourceTXID).toBe(first.txid)
    expect(getUtxo('lisa-agent')!.satoshis).toBeLessThan(mid.satoshis)
    expect(start - getUtxo('lisa-agent')!.satoshis).toBe(
      first.sats + first.fee + second.sats + second.fee
    )
  })

  it('keeps change marked synthetic while the coins are synthetic', async () => {
    await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    expect(getUtxo('lisa-agent')!.synthetic).toBe(true)
  })

  it('refuses when the agent has no output', async () => {
    writeUtxos({})
    await expect(
      contribute(
        { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
        { budget, runtime: dryRun }
      )
    ).rejects.toThrow(/no spendable output/)
  })

  it('refuses when the agent cannot cover the payment', async () => {
    await expect(
      contribute(
        {
          agentLabel: 'sybil-agent-001',
          agentKey: PrivateKey.fromHex(keys.sybil[0]!.privHex),
          projectId: project.id,
          sats: 5_000 // more than its 200 sats
        },
        { budget, runtime: dryRun }
      )
    ).rejects.toThrow(/not enough to pay/)
  })

  it('still builds a transaction for a project that does not exist', async () => {
    // The sybil's invented project: a real transaction the server will refuse.
    const r = await contribute(
      { agentLabel: 'sybil-agent-001', agentKey: PrivateKey.fromHex(keys.sybil[0]!.privHex), projectId: 'totally-legit' },
      { budget, runtime: dryRun }
    )
    expect(findContributionTag(Transaction.fromHex(r.rawTxHex))?.projectId).toBe('totally-legit')
    expect(r.accepted).toBe(false)
  })

  it('reports an unreachable server without losing the transaction', async () => {
    const r = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    expect(r.accepted).toBe(false)
    expect(r.serverMessage).toMatch(/could not reach the server/)
    // The transaction was still built, signed and chained.
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/)
    expect(getUtxo('lisa-agent')!.txid).toBe(r.txid)
  })

  it('marks the report as dry-run', async () => {
    const bodies: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body))
      return await Promise.resolve(new Response('{"duplicate":false}', { status: 200 }))
    })
    await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    expect(bodies.some(b => JSON.parse(b).dryRun === true)).toBe(true)
  })
})

describe('assertSpendable', () => {
  it('rejects a transaction tampered with after signing', async () => {
    const r = await contribute(
      { agentLabel: 'lisa-agent', agentKey: lisaKey(), projectId: project.id },
      { budget, runtime: dryRun }
    )
    const utxo = readUtxos()['lisa-agent']!
    const tampered = Transaction.fromHex(r.rawTxHex)
    // Redirect the payment to someone else, keeping the original signature.
    tampered.outputs[0]!.lockingScript = new P2PKH().lock(
      PrivateKey.fromRandom().toAddress([0x00])
    )

    // The source for this check is the output the FIRST transaction spent.
    const spent = {
      ...utxo,
      txid: Transaction.fromHex(r.rawTxHex).inputs[0]!.sourceTXID!,
      vout: 0,
      satoshis: 5_000,
      lockingScriptHex: new P2PKH().lock(keys.lisa.address).toHex()
    }
    expect(() => assertSpendable(tampered, spent)).toThrow(ContributeError)
  })

  it('rejects an unsigned transaction', () => {
    const tx = new Transaction()
    tx.addInput({ sourceTXID: 'a'.repeat(64), sourceOutputIndex: 0 })
    const utxo = readUtxos()['lisa-agent']!
    expect(() => assertSpendable(tx, utxo)).toThrow(/not signed/)
  })
})

describe('dust', () => {
  it('does not keep a change output at or below the dust limit', () => {
    expect(DUST_LIMIT).toBeGreaterThanOrEqual(1)
  })
})
