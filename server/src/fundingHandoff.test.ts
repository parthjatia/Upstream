import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARC, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordFunding } from './funding'
import { getUtxo } from '../../agents/lib/utxos'
import { contribute } from '../../agents/lib/contribute'
import { loadBudget } from '@upstream/shared/budget'
import { loadRuntime } from '@upstream/shared/runtime'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-handoff-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterEach(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
it('hands wallet outputs to the live contribution path and never reimports spent funding on a retry', async () => {
  const key = PrivateKey.fromRandom()
  const address = key.toAddress([0])
  const funding = new Transaction()
  funding.addOutput({
    lockingScript: new P2PKH().lock(address),
    satoshis: 5000
  })
  // Network/SPV verification belongs to the HTTP boundary; this tests its handoff.
  const args = {
    scope: 'lisa' as const,
    round: 'round-1',
    txid: funding.id('hex'),
    beefHex: 'fixture',
    tx: funding,
    targets: [
      { label: 'lisa-agent', kind: 'lisa' as const, address, satoshis: 5000 }
    ]
  }
  recordFunding(args)
  expect(getUtxo('lisa-agent')).toMatchObject({
    txid: args.txid,
    synthetic: false,
    satoshis: 5000
  })
  vi.spyOn(ARC.prototype, 'broadcast').mockImplementation(async (tx) => ({
    status: 'success',
    txid: tx.id('hex'),
    message: 'SEEN_ON_NETWORK'
  }))
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { status: 200 })
  )
  const paid = await contribute(
    { agentLabel: 'lisa-agent', agentKey: key, projectId: 'tiny-tls' },
    { budget: loadBudget({}), runtime: loadRuntime({ DRY_RUN: 'false' }) }
  )
  expect(paid).toMatchObject({ broadcast: true, accepted: true, sats: 10 })
  expect(getUtxo('lisa-agent')?.txid).toBe(paid.txid)
  recordFunding(args)
  expect(getUtxo('lisa-agent')?.txid).toBe(paid.txid)
})

it('keeps the input available and records no payment after a rejected broadcast', async () => {
  const key = PrivateKey.fromRandom()
  const tx = new Transaction()
  const address = key.toAddress([0])
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: 5000 })
  recordFunding({
    scope: 'lisa',
    round: 'round-1',
    txid: tx.id('hex'),
    beefHex: 'fixture',
    tx,
    targets: [{ label: 'lisa-agent', kind: 'lisa', address, satoshis: 5000 }]
  })
  const report = vi.spyOn(globalThis, 'fetch')
  vi.spyOn(ARC.prototype, 'broadcast').mockResolvedValue({
    status: 'error',
    code: 'REJECTED',
    description: 'Fee too low'
  })
  await expect(
    contribute(
      { agentLabel: 'lisa-agent', agentKey: key, projectId: 'tiny-tls' },
      { budget: loadBudget({}), runtime: loadRuntime({ DRY_RUN: 'false' }) }
    )
  ).rejects.toThrow('REJECTED')
  expect(getUtxo('lisa-agent')?.txid).toBe(tx.id('hex'))
  expect(report).not.toHaveBeenCalled()
})
