import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hash, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PROJECTS } from '@upstream/shared/projects'
import { readTagFromScript } from '@upstream/shared/opreturn'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-settle-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterAll(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

const { allContributions, storeContribution } = await import('./contributions.ts')
const { dataPath, writeJson } = await import('./store.ts')
const { previewSettlement, recordSettlement, allSettlements, SettlementError } = await import(
  './settlement.ts'
)
const { readSettlementScript, settlementOutputs, resultsHash, checkSettlementTx } = await import(
  '@upstream/shared/settlement'
)

const ROUND = 'round-1'
const POOL = 1_000
const opts = { round: ROUND, network: 'mainnet', pool: POOL, serverDryRun: true }

const [crowd, solo, idle] = [PROJECTS[0]!, PROJECTS[1]!, PROJECTS[2]!]
let n = 0
const fakeTxid = (): string => Utils.toHex(Hash.sha256(Utils.toArray(`tx-${n++}`, 'utf8')))

function contribute(project: string, owner: string, sats: number, dryRun = true): void {
  storeContribution({
    txid: fakeTxid(),
    round: ROUND,
    project,
    owner,
    agent: `agent-${owner}`,
    sats,
    outputIndex: 0,
    dryRun,
    createdAt: new Date().toISOString()
  })
}

/** Build the transaction a wallet would produce from the preview, plus change. */
function walletTx(resultsJson: string, opts2: { shuffle?: boolean; skip?: string } = {}) {
  const outs = settlementOutputs(resultsJson).filter(o => opts2.skip === undefined || o.project !== opts2.skip)
  if (opts2.shuffle === true) outs.reverse()
  const tx = new Transaction()
  for (const o of outs) tx.addOutput({ lockingScript: Script.fromHex(o.lockingScript), satoshis: o.satoshis })
  tx.addOutput({
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    satoshis: 777
  })
  return tx
}

beforeEach(() => {
  writeJson(dataPath('contributions.json'), [])
  writeJson(dataPath('settlements.json'), [])
})

describe('settlement preview', () => {
  it('has nothing to settle with no contributions', () => {
    const p = previewSettlement(opts)
    expect(p.settleable).toBe(false)
    expect(p.reason).toMatch(/no verified contributions/)
    expect(p.outputs).toHaveLength(1)
    expect(p.outputs[0]!.kind).toBe('data')
    expect(p.totalSats).toBe(0)
  })

  it('pays one P2PKH output per project with match > 0, plus the OP_RETURN', () => {
    for (let i = 0; i < 5; i++) contribute(crowd.id, `crowd-${i}`, 10)
    contribute(solo.id, 'whale', 5_000) // one supporter: match 0
    contribute(idle.id, 'a', 10)
    contribute(idle.id, 'b', 10)

    const p = previewSettlement(opts)
    expect(p.settleable).toBe(true)

    const projectOuts = p.outputs.filter(o => o.kind === 'project')
    expect(projectOuts.map(o => o.project).sort()).toEqual([crowd.id, idle.id].sort())
    for (const o of projectOuts) {
      const project = PROJECTS.find(x => x.id === o.project)!
      expect(o.lockingScript).toBe(new P2PKH().lock(project.address).toHex())
      expect(o.satoshis).toBe(p.results.rows.find(r => r.project === o.project)!.match)
      expect(o.satoshis).toBeGreaterThan(0)
    }
    expect(p.totalSats).toBe(projectOuts.reduce((a, o) => a + o.satoshis, 0))
    expect(p.totalSats).toBeLessThanOrEqual(POOL)

    // The whale is listed in the results but gets no output.
    expect(p.results.rows.find(r => r.project === solo.id)!.match).toBe(0)
  })

  it('puts the SHA-256 of the results JSON in the OP_RETURN', () => {
    contribute(crowd.id, 'a', 10)
    contribute(crowd.id, 'b', 10)
    const p = previewSettlement(opts)

    const expected = Utils.toHex(Hash.sha256(Utils.toArray(p.resultsJson, 'utf8')))
    expect(p.resultsHash).toBe(expected)

    const data = p.outputs.find(o => o.kind === 'data')!
    expect(data.satoshis).toBe(0)
    expect(readSettlementScript(Script.fromHex(data.lockingScript))).toEqual({
      round: ROUND,
      hash: expected
    })
    // Never mistaken for a contribution tag.
    expect(readTagFromScript(Script.fromHex(data.lockingScript))).toBeNull()
  })

  it('is deterministic, whatever order contributions arrived in', () => {
    contribute(crowd.id, 'a', 10)
    contribute(idle.id, 'b', 20)
    contribute(crowd.id, 'c', 10)
    const first = previewSettlement(opts).resultsHash
    expect(previewSettlement(opts).resultsHash).toBe(first)

    writeJson(dataPath('contributions.json'), [...allContributions()].reverse())
    expect(previewSettlement(opts).resultsHash).toBe(first)
  })

  it('warns when the tally contains dry-run contributions', () => {
    contribute(crowd.id, 'a', 10, true)
    contribute(crowd.id, 'b', 10, false)
    const p = previewSettlement(opts)
    expect(p.dryRunContributions).toBe(1)
    expect(p.warnings.join(' ')).toMatch(/dry run/)
  })
})

describe('recording a settlement', () => {
  const setup = () => {
    for (let i = 0; i < 3; i++) contribute(crowd.id, `o${i}`, 10)
    contribute(idle.id, 'x', 10)
    contribute(idle.id, 'y', 40)
    return previewSettlement(opts)
  }
  const post = (tx: Transaction, resultsJson: string) =>
    recordSettlement(
      { txid: tx.id('hex'), beefHex: Utils.toHex(tx.toAtomicBEEF()), resultsJson },
      { round: ROUND, resultsJson }
    )

  it('accepts the wallet transaction, wherever the outputs landed', () => {
    const p = setup()
    const tx = walletTx(p.resultsJson, { shuffle: true })
    const record = post(tx, p.resultsJson)
    expect(record.txid).toBe(tx.id('hex'))
    expect(record.resultsHash).toBe(p.resultsHash)
    expect(record.matchesCurrentTally).toBe(true)
    for (const o of record.outputs) {
      expect(tx.outputs[o.index]!.lockingScript.toHex()).toBe(
        p.outputs.find(x => (x.project ?? null) === o.project)!.lockingScript
      )
    }
    expect(allSettlements()).toHaveLength(1)
    expect(previewSettlement(opts).settleable).toBe(false)
    expect(previewSettlement(opts).settled?.txid).toBe(tx.id('hex'))

    // Idempotent.
    post(tx, p.resultsJson)
    expect(allSettlements()).toHaveLength(1)
  })

  it('refuses a transaction missing a project payment', () => {
    const p = setup()
    const tx = walletTx(p.resultsJson, { skip: idle.id })
    expect(() => post(tx, p.resultsJson)).toThrow(SettlementError)
    expect(() => post(tx, p.resultsJson)).toThrow(/no output pays/)
  })

  it('refuses a transaction whose OP_RETURN carries another hash', () => {
    const p = setup()
    const tx = walletTx(p.resultsJson)
    const tampered = p.resultsJson.replace('"pool":1000', '"pool":1001')
    expect(() => checkSettlementTx(tx, tampered)).toThrow(/OP_RETURN/)
  })

  it('refuses results that redirect a project to another address', () => {
    const p = setup()
    const evil = PrivateKey.fromRandom().toAddress()
    const tampered = p.resultsJson.replace(crowd.address, evil)
    expect(resultsHash(tampered)).not.toBe(p.resultsHash)
    expect(() => settlementOutputs(tampered)).toThrow(/registry says/)
  })

  it('records, but flags, a settlement made against an older tally', () => {
    const p = setup()
    const tx = walletTx(p.resultsJson)
    contribute(crowd.id, 'late', 10)
    const now = previewSettlement(opts)
    const record = recordSettlement(
      { txid: tx.id('hex'), beefHex: Utils.toHex(tx.toAtomicBEEF()), resultsJson: p.resultsJson },
      { round: ROUND, resultsJson: now.resultsJson }
    )
    expect(record.matchesCurrentTally).toBe(false)
  })

  it('refuses a BEEF for another txid', () => {
    const p = setup()
    const tx = walletTx(p.resultsJson)
    expect(() =>
      recordSettlement(
        { txid: 'ab'.repeat(32), beefHex: Utils.toHex(tx.toAtomicBEEF()), resultsJson: p.resultsJson },
        { round: ROUND, resultsJson: p.resultsJson }
      )
    ).toThrow(/BEEF is for/)
  })
})
