/**
 * Phase 9 routes, mounted by `server/src/index.ts`.
 *
 *   GET  /settlement/preview  what the sponsor's wallet should pay, and why
 *   POST /settlement          record a settlement BSV Desktop broadcast
 *   GET  /settlement          settlements recorded so far
 */
import { Router } from 'express'
import type { TallyRow } from '@upstream/shared'
import { tally } from './contributions.ts'
import { emit } from './events.ts'
import {
  SettlementError,
  allSettlements,
  previewSettlement,
  recordSettlement
} from './settlement.ts'
import { parseResults } from '@upstream/shared/settlement'

export interface SettlementRouteOptions {
  round: string
  network: string
  serverDryRun: boolean
  /** Read per request: the sponsor can change the pledge at any time. */
  pool: () => number
}

export function settlementRouter(opts: SettlementRouteOptions): Router {
  const router = Router()
  const preview = () =>
    previewSettlement({
      round: opts.round,
      network: opts.network,
      pool: opts.pool(),
      serverDryRun: opts.serverDryRun
    })

  router.get('/settlement/preview', (_req, res) => {
    try {
      res.json(preview())
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.get('/settlement', (_req, res) => {
    res.json(allSettlements().map(({ beefHex: _omit, ...s }) => s))
  })

  router.post('/settlement', (req, res) => {
    try {
      const current = preview()
      const record = recordSettlement((req.body ?? {}) as Record<string, unknown>, {
        round: opts.round,
        resultsJson: current.resultsJson
      })

      // The galaxy wants tally rows; take gap from the live tally where known.
      const live = new Map(tally(opts.round, opts.pool()).rows.map(r => [r.project, r]))
      const rows: TallyRow[] = parseResults(record.resultsJson).rows.map(r => ({
        project: r.project,
        raised: r.raised,
        supporters: r.supporters,
        gap: live.get(r.project)?.gap ?? 0,
        match: r.match
      }))
      emit({ type: 'settled', txid: record.txid, rows })
      console.log(
        `settled ${opts.round}: ${record.totalSats} sats to ${record.outputs.length - 1} project(s) · ${record.txid}` +
          (record.matchesCurrentTally ? '' : ' (tally moved on since the preview)')
      )
      const { beefHex: _omit, ...publicRecord } = record
      res.json(publicRecord)
    } catch (err) {
      const status = err instanceof SettlementError ? 400 : 500
      console.warn(`settlement refused: ${(err as Error).message}`)
      res.status(status).json({ error: (err as Error).message })
    }
  })

  return router
}
