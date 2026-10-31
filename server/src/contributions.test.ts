import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { signAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'
import { contributionScript } from '@upstream/shared/opreturn'
import { loadBudget } from '@upstream/shared/budget'
import { PROJECTS } from '@upstream/shared/projects'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-contrib-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterAll(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

const {
  allContributions,
  storeContribution,
  tally,
  verifyContribution,
  readPool,
  writePool
} = await import('./contributions.ts')
const { dataPath, writeJson } = await import('./store.ts')

const ROUND = 'round-1'
const budget = loadBudget({})
const opts = { round: ROUND, budget }

const project = PROJECTS[0]! // tiny-tls
const other = PROJECTS[1]! // stream-utils

const agentKey = (): PrivateKey => PrivateKey.fromRandom()

/** An agent with a real owner attestation, as Phase 7 will produce. */
async function vouchedAgent(): Promise<{ agentPubKey: string; att: AgentAttestation }> {
  const agent = agentKey().toPublicKey().toString()
  const att = await signAgentAttestation(new ProtoWallet(PrivateKey.fromRandom()), agent)
  return { agentPubKey: agent, att }
}

/**
 * A contribution-shaped transaction: payment to the project, the OP_RETURN tag,
 * then change back to the agent. Built offline and never broadcast — Phase 5
 * verifies structure, so a funded input is not needed.
 */
function contributionTx(opts2: {
  address?: string
  sats?: number
  round?: string
  projectId?: string
  omitTag?: boolean
  omitPayment?: boolean
}): Transaction {
  const tx = new Transaction()
  if (opts2.omitPayment !== true) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(opts2.address ?? project.address),
      satoshis: opts2.sats ?? budget.contributionSats
    })
  }
  if (opts2.omitTag !== true) {
    tx.addOutput({
      lockingScript: Script.fromHex(
        contributionScript(opts2.round ?? ROUND, opts2.projectId ?? project.id)
      ),
      satoshis: 0
    })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(agentKey().toAddress([0x00])), satoshis: 1_400 })
  return tx
}

const report = async (overrides: Record<string, unknown> = {}) => {
  const { agentPubKey, att } = await vouchedAgent()
  return {
    rawTxHex: contributionTx({}).toHex(),
    projectId: project.id,
    agentPubKey,
    ownerPubKey: att.ownerPubKey,
    ownerSignature: att.signature,
    ...overrides
  }
}

beforeEach(() => {
  writeJson(dataPath('contributions.json'), [])
  writeJson(dataPath('rejected.json'), [])
})

describe('verifyContribution', () => {
  it('accepts a well-formed contribution', async () => {
    const { agentPubKey, att } = await vouchedAgent()
    const tx = contributionTx({})
    const c = await verifyContribution(
      {
        rawTxHex: tx.toHex(),
        projectId: project.id,
        agentPubKey,
        ownerPubKey: att.ownerPubKey,
        ownerSignature: att.signature
      },
      opts
    )
    expect(c.project).toBe(project.id)
    expect(c.owner).toBe(att.ownerPubKey)
    expect(c.sats).toBe(budget.contributionSats)
    expect(c.outputIndex).toBe(0)
    expect(c.round).toBe(ROUND)
    expect(c.txid).toBe(tx.id('hex'))
  })

  it('finds the paying output by script, not by position', async () => {
    const { agentPubKey, att } = await vouchedAgent()
    // Tag first, payment second.
    const tx = new Transaction()
    tx.addOutput({
      lockingScript: Script.fromHex(contributionScript(ROUND, project.id)),
      satoshis: 0
    })
    tx.addOutput({ lockingScript: new P2PKH().lock(project.address), satoshis: 25 })
    const c = await verifyContribution(
      {
        rawTxHex: tx.toHex(),
        projectId: project.id,
        agentPubKey,
        ownerPubKey: att.ownerPubKey,
        ownerSignature: att.signature
      },
      opts
    )
    expect(c.outputIndex).toBe(1)
    expect(c.sats).toBe(25)
  })

  it('rejects an unknown project', async () => {
    await expect(verifyContribution(await report({ projectId: 'totally-legit' }), opts)).rejects.toThrow(
      /unknown project "totally-legit"/
    )
  })

  it('rejects a transaction with no tag', async () => {
    const r = await report({ rawTxHex: contributionTx({ omitTag: true }).toHex() })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/no OP_RETURN/)
  })

  it('rejects a tag for another round', async () => {
    const r = await report({ rawTxHex: contributionTx({ round: 'round-99' }).toHex() })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/round "round-99"/)
  })

  it('rejects a tag that names a different project than the report', async () => {
    const r = await report({ rawTxHex: contributionTx({ projectId: other.id }).toHex() })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/tag names project/)
  })

  it('rejects when no output pays the project', async () => {
    // Tag says tiny-tls, but the money went to stream-utils' address.
    const r = await report({ rawTxHex: contributionTx({ address: other.address }).toHex() })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/no output pays tiny-tls/)
  })

  it('rejects an amount below CONTRIBUTION_SATS', async () => {
    const r = await report({ rawTxHex: contributionTx({ sats: 1 }).toHex() })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/below CONTRIBUTION_SATS=10/)
  })

  it('accepts more than CONTRIBUTION_SATS — the whale pays a lot', async () => {
    const r = await report({ rawTxHex: contributionTx({ sats: 19_500 }).toHex() })
    expect((await verifyContribution(r, opts)).sats).toBe(19_500)
  })

  it('rejects an agent with NO owner signature — the sybil attack', async () => {
    await expect(
      verifyContribution(await report({ ownerSignature: '' }), opts)
    ).rejects.toThrow(/ownerSignature is required/)
    await expect(verifyContribution(await report({ ownerPubKey: '' }), opts)).rejects.toThrow(
      /ownerPubKey is required/
    )
  })

  it('rejects an owner signature that does not verify', async () => {
    const impostor = await new ProtoWallet(PrivateKey.fromRandom()).getPublicKey({
      identityKey: true
    })
    const r = await report({ ownerPubKey: impostor.publicKey })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/does not verify/)
  })

  it('rejects a signature made for a different agent', async () => {
    const r = await report({ agentPubKey: agentKey().toPublicKey().toString() })
    await expect(verifyContribution(r, opts)).rejects.toThrow(/does not verify/)
  })

  it('rejects malformed input rather than throwing something opaque', async () => {
    await expect(verifyContribution(await report({ rawTxHex: 'zzz' }), opts)).rejects.toThrow(
      /not a transaction/
    )
    await expect(verifyContribution(await report({ rawTxHex: '' }), opts)).rejects.toThrow(
      /rawTxHex is required/
    )
  })
})

describe('storeContribution', () => {
  const made = async () => await verifyContribution(await report(), opts)

  it('stores a new contribution', async () => {
    const { isNew } = storeContribution(await made())
    expect(isNew).toBe(true)
    expect(allContributions()).toHaveLength(1)
  })

  it('is idempotent on txid and output, so a retry cannot inflate a total', async () => {
    const c = await made()
    expect(storeContribution(c).isNew).toBe(true)
    expect(storeContribution(c).isNew).toBe(false)
    expect(storeContribution({ ...c, createdAt: 'later' }).isNew).toBe(false)
    expect(allContributions()).toHaveLength(1)
  })
})

describe('tally', () => {
  /** n distinct owners each paying `sats` to `projectId`. */
  const give = async (projectId: string, owners: number, sats: number) => {
    for (let i = 0; i < owners; i++) {
      const agent = agentKey().toPublicKey().toString()
      const att = await signAgentAttestation(new ProtoWallet(PrivateKey.fromRandom()), agent)
      const tx = contributionTx({
        address: PROJECTS.find(p => p.id === projectId)!.address,
        projectId,
        sats
      })
      storeContribution(
        await verifyContribution(
          {
            rawTxHex: tx.toHex(),
            projectId,
            agentPubKey: agent,
            ownerPubKey: att.ownerPubKey,
            ownerSignature: att.signature
          },
          opts
        )
      )
    }
  }

  it('is empty before anything happens', () => {
    const t = tally(ROUND, 50_000)
    expect(t.rows).toEqual([])
    expect(t.contributions).toBe(0)
    expect(t.owners).toBe(0)
    expect(t.totalMatched).toBe(0)
  })

  it('gives the crowd the match and the whale nothing', async () => {
    await give('tiny-tls', 1, 19_500) // whale: one owner
    await give('stream-utils', 8, 10) // crowd: eight owners

    const t = tally(ROUND, 50_000)
    const whale = t.rows.find(r => r.project === 'tiny-tls')!
    const crowd = t.rows.find(r => r.project === 'stream-utils')!

    expect(whale.raised).toBe(19_500)
    expect(whale.supporters).toBe(1)
    expect(whale.match).toBe(0)

    expect(crowd.raised).toBe(80)
    expect(crowd.supporters).toBe(8)
    expect(crowd.match).toBe(50_000)

    expect(t.owners).toBe(9)
    expect(t.contributions).toBe(9)
    expect(t.totalRaised).toBe(19_580)
  })

  it('sorts the biggest match first', async () => {
    await give('tiny-tls', 2, 100)
    await give('stream-utils', 6, 100)
    const matches = tally(ROUND, 50_000).rows.map(r => r.match)
    expect(matches).toEqual([...matches].sort((a, b) => b - a))
  })

  it('counts one owner once however many agents it runs', async () => {
    const owner = new ProtoWallet(PrivateKey.fromRandom())
    for (let i = 0; i < 5; i++) {
      const agent = agentKey().toPublicKey().toString()
      const att = await signAgentAttestation(owner, agent)
      storeContribution(
        await verifyContribution(
          {
            rawTxHex: contributionTx({}).toHex(),
            projectId: project.id,
            agentPubKey: agent,
            ownerPubKey: att.ownerPubKey,
            ownerSignature: att.signature
          },
          opts
        )
      )
    }
    const t = tally(ROUND, 50_000)
    expect(t.contributions).toBe(5)
    expect(t.owners).toBe(1)
    expect(t.rows[0]!.supporters).toBe(1)
    expect(t.rows[0]!.match).toBe(0) // no gap: a single owner earns no match
  })

  it('never pays out more than the pool', async () => {
    await give('tiny-tls', 4, 50)
    await give('stream-utils', 7, 10)
    await give('log-helper', 3, 200)
    const t = tally(ROUND, 50_000)
    expect(t.totalMatched).toBeLessThanOrEqual(50_000)
  })

  it('ignores contributions from another round', async () => {
    await give('tiny-tls', 3, 10)
    expect(tally('round-2', 50_000).rows).toEqual([])
    expect(tally(ROUND, 50_000).rows).toHaveLength(1)
  })
})

describe('pledge', () => {
  it('defaults to the budget pool until the sponsor sets one', () => {
    writeJson(dataPath('pool.json'), { pool: budget.sponsorPoolSats })
    expect(readPool(budget.sponsorPoolSats)).toBe(50_000)
  })

  it('remembers what the sponsor pledged', () => {
    writePool(12_345)
    expect(readPool(budget.sponsorPoolSats)).toBe(12_345)
  })

  it('changes the matching split without touching the contributions', async () => {
    const agent = agentKey().toPublicKey().toString()
    const att = await signAgentAttestation(new ProtoWallet(PrivateKey.fromRandom()), agent)
    storeContribution(
      await verifyContribution(
        {
          rawTxHex: contributionTx({}).toHex(),
          projectId: project.id,
          agentPubKey: agent,
          ownerPubKey: att.ownerPubKey,
          ownerSignature: att.signature
        },
        opts
      )
    )
    const agent2 = agentKey().toPublicKey().toString()
    const att2 = await signAgentAttestation(new ProtoWallet(PrivateKey.fromRandom()), agent2)
    storeContribution(
      await verifyContribution(
        {
          rawTxHex: contributionTx({ sats: 20 }).toHex(),
          projectId: project.id,
          agentPubKey: agent2,
          ownerPubKey: att2.ownerPubKey,
          ownerSignature: att2.signature
        },
        opts
      )
    )

    expect(tally(ROUND, 1_000).rows[0]!.match).toBe(1_000)
    expect(tally(ROUND, 2_000).rows[0]!.match).toBe(2_000)
    expect(tally(ROUND, 0).rows[0]!.match).toBe(0)
  })
})
