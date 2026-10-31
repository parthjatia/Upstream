/** Local controls for the existing agent contribution path. No keys cross HTTP. */
import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { PrivateKey } from '@bsv/sdk'
import type { Budget } from '@upstream/shared/budget'
import { loadKeys } from '@upstream/shared/keystore'
import { findProject } from '@upstream/shared/projects'
import type { Runtime } from '@upstream/shared/runtime'
import type {
  PaymentGroup,
  PaymentRun,
  PaymentStatus
} from '../../shared/paymentRun.ts'
import {
  contribute,
  type ContributionRequest
} from '../../agents/lib/contribute.ts'
import { getUtxo } from '../../agents/lib/utxos.ts'
import { allAttestations } from './identity.ts'
import { settlementFor } from './settlement.ts'

export const localAddress = (address?: string): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

export function paymentRouter(
  runtime: Runtime,
  budget: Budget,
  deps = {
    loadKeys,
    getUtxo,
    allAttestations,
    contribute,
    settlementFor
  }
) {
  const router = Router()
  const token = randomBytes(32).toString('hex')
  const runs = new Map<string, PaymentRun>()
  let run: PaymentRun | null = null
  const origins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])
  if (process.env.UPSTREAM_WEB_ORIGIN)
    origins.add(process.env.UPSTREAM_WEB_ORIGIN)

  router.use((req, res, next) => {
    if (
      !localAddress(req.socket.remoteAddress) ||
      !origins.has(req.get('origin') ?? '')
    ) {
      res.status(403).json({
        error:
          'Agent payment controls are only available from the local Upstream app.'
      })
      return
    }
    next()
  })

  const requests = (
    group: PaymentGroup,
    projectId: string
  ): ContributionRequest[] => {
    const keys = deps.loadKeys()
    if (group === 'swarm')
      return keys.swarm.map(({ agent, owner }) => ({
        agentLabel: agent.label,
        agentKey: PrivateKey.fromHex(agent.privHex),
        owner: PrivateKey.fromHex(owner.privHex),
        projectId
      }))
    const attestation = deps
      .allAttestations()
      .find((a) => a.agentPubKey === keys.lisa.pubKey)
    if (!attestation)
      throw new Error('Authorize Lisa’s owner signature in BSV Desktop first.')
    return [
      {
        agentLabel: keys.lisa.label,
        agentKey: PrivateKey.fromHex(keys.lisa.privHex),
        attestation,
        projectId
      }
    ]
  }
  const check = (payments: ContributionRequest[]): string | null => {
    if (runtime.dryRun) return 'The backend is in dry-run mode.'
    if (runtime.network !== 'mainnet')
      return 'This payment flow requires mainnet.'
    if (deps.settlementFor(runtime.round))
      return 'This round is already settled.'
    if (payments.length === 0) return 'No agents configured.'
    for (const p of payments) {
      const utxo = deps.getUtxo(p.agentLabel)
      if (!utxo || utxo.synthetic) return 'Fund the agents with real BSV first.'
      if (utxo.satoshis <= budget.contributionSats + 1)
        return `${p.agentLabel} needs more funding.`
    }
    return null
  }
  router.get('/', (_req, res) => {
    const group = (kind: PaymentGroup) => {
      try {
        const payments = requests(kind, 'tiny-tls')
        const reason = check(payments)
        return { count: payments.length, ready: reason === null, reason }
      } catch (e) {
        return {
          count: kind === 'lisa' ? 1 : budget.swarmSize,
          ready: false,
          reason: (e as Error).message
        }
      }
    }
    const status: PaymentStatus = {
      live: !runtime.dryRun,
      token,
      satsPerPayment: budget.contributionSats,
      groups: { lisa: group('lisa'), swarm: group('swarm') },
      run
    }
    res.json(status)
  })
  router.post('/', (req, res) => {
    const { token: supplied, id, group, projectId } = req.body ?? {}
    if (supplied !== token) {
      res
        .status(403)
        .json({ error: 'Reload the payment controls before starting.' })
      return
    }
    if (
      typeof id !== 'string' ||
      !/^[a-z0-9-]{16,80}$/i.test(id) ||
      !['lisa', 'swarm'].includes(group) ||
      typeof projectId !== 'string' ||
      !findProject(projectId)
    ) {
      res
        .status(400)
        .json({ error: 'Choose a valid payment group and project.' })
      return
    }
    if (runs.has(id)) {
      res.json(runs.get(id))
      return
    }
    if (run?.state === 'running') {
      res.status(409).json({ error: 'Agent payments are already running.' })
      return
    }
    try {
      const payments = requests(group, projectId)
      const reason = check(payments)
      if (reason) {
        res.status(409).json({ error: reason })
        return
      }
      const current: PaymentRun = {
        id,
        state: 'running',
        completed: 0,
        total: payments.length,
        txids: []
      }
      runs.set(id, current)
      run = current
      res.status(202).json(current)
      void (async () => {
        try {
          for (const payment of payments) {
            const result = await deps.contribute(payment, { budget, runtime })
            if (result.broadcast) current.txids.push(result.txid)
            if (!result.broadcast || !result.accepted)
              throw new Error(
                result.serverMessage || 'Payment was not broadcast.'
              )
            current.completed++
          }
          current.state = 'complete'
        } catch (e) {
          current.state = 'failed'
          current.error = (e as Error).message
        }
      })()
    } catch (e) {
      res.status(409).json({ error: (e as Error).message })
    }
  })
  return router
}
