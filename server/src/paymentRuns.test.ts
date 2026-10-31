import express from 'express'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKey } from '@upstream/shared/keystore'
import { loadBudget } from '@upstream/shared/budget'
import { loadRuntime } from '@upstream/shared/runtime'
import { paymentRouter } from './paymentRuns'
import type { ContributionResult } from '../../agents/lib/contribute'
import type { PaymentStatus } from '../../shared/paymentRun'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((resolve) => s.close(() => resolve()))
})

async function setup(dryRun = false) {
  const lisa = generateKey('lisa-agent')
  const keys = {
    projects: [],
    lisa,
    swarm: [
      {
        agent: generateKey('swarm-agent-001'),
        owner: generateKey('swarm-owner-001')
      }
    ],
    whale: {
      agent: generateKey('whale-agent'),
      owner: generateKey('whale-owner')
    },
    sybil: []
  }
  const result: ContributionResult = {
    txid: 'a'.repeat(64),
    rawTxHex: '',
    projectId: 'tiny-tls',
    sats: 10,
    fee: 1,
    change: 100,
    dryRun: false,
    broadcast: true,
    accepted: true,
    serverMessage: 'counted',
    explorerUrl: ''
  }
  const deps = {
    loadKeys: () => keys,
    getUtxo: vi.fn(() => ({
      agent: lisa.label,
      txid: 'b'.repeat(64),
      vout: 0,
      satoshis: 5000,
      lockingScriptHex: '',
      sourceTxHex: '',
      synthetic: false,
      origin: 'funding-import' as const,
      updatedAt: ''
    })),
    allAttestations: () => [
      {
        label: lisa.label,
        agentPubKey: lisa.pubKey,
        ownerPubKey: keys.swarm[0]!.owner.pubKey,
        signature: 'signature',
        verified: true as const,
        createdAt: ''
      }
    ],
    contribute: vi.fn(async () => result),
    settlementFor: () => null
  }
  const app = express()
  app.use(express.json())
  app.use(
    '/agent-payments',
    paymentRouter(
      loadRuntime({ DRY_RUN: String(dryRun) }),
      loadBudget({}),
      deps
    )
  )
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await new Promise<void>((resolve) => server.on('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server port')
  const url = `http://127.0.0.1:${address.port}/agent-payments`
  const headers = {
    origin: 'http://localhost:5173',
    'content-type': 'application/json'
  }
  const status = (await (await fetch(url, { headers })).json()) as PaymentStatus
  const send = (overrides = {}) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: status.token,
        id: 'request-1234567890',
        group: 'lisa',
        projectId: 'tiny-tls',
        ...overrides
      })
    })
  return { url, headers, status, send, deps }
}

describe('local live payment controls', () => {
  it('uses the real contribution path once and deduplicates request retries', async () => {
    const { send, deps } = await setup()
    expect((await send()).status).toBe(202)
    expect((await send()).status).toBe(200)
    expect(deps.contribute).toHaveBeenCalledTimes(1)
    expect(deps.contribute.mock.calls[0]).toBeDefined()
  })
  it('refuses dry-run and synthetic funding before spending', async () => {
    const dry = await setup(true)
    expect((await dry.send()).status).toBe(409)
    expect(dry.deps.contribute).not.toHaveBeenCalled()
    const live = await setup()
    live.deps.getUtxo.mockReturnValue({
      ...live.deps.getUtxo()!,
      synthetic: true
    })
    expect((await live.send()).status).toBe(409)
    expect(live.deps.contribute).not.toHaveBeenCalled()
  })
  it('rejects other websites, missing session tokens, and unknown recipients', async () => {
    const { url, send, deps } = await setup()
    expect(
      (await fetch(url, { headers: { origin: 'https://other.example' } }))
        .status
    ).toBe(403)
    expect((await send({ token: 'wrong' })).status).toBe(403)
    expect((await send({ projectId: 'not-a-project' })).status).toBe(400)
    expect(deps.contribute).not.toHaveBeenCalled()
  })
  it('reports broadcast failures without inventing receipts', async () => {
    const { url, headers, send, deps } = await setup()
    deps.contribute.mockRejectedValue(new Error('Arcade rejected payment'))
    await send()
    const status = (await (
      await fetch(url, { headers })
    ).json()) as PaymentStatus
    expect(status.run).toMatchObject({
      state: 'failed',
      completed: 0,
      txids: [],
      error: 'Arcade rejected payment'
    })
  })
  it('blocks concurrent runs while a payment is in flight', async () => {
    const { send, deps } = await setup()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const result = await deps.contribute()
    deps.contribute.mockImplementation(async () => {
      await pending
      return result
    })
    await send()
    expect((await send({ id: 'different-1234567890' })).status).toBe(409)
    release()
  })
})
