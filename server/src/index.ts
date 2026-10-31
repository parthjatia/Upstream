/**
 * Upstream tally server.
 *
 * Phase 3: owns the funding plan (it is the only side that can read `keys/`),
 * records the funding transactions BSV Desktop broadcasts, and stores owner
 * attestations.
 *
 * Phase 5: verifies contributions against the raw transaction, runs quadratic
 * matching over the verified ones, and streams events to the UI.
 *
 * Phase 9: the settlement routes, mounted from `settlementRoutes.ts`.
 *
 * It never holds, asks for, or returns a private key.
 */
import cors from 'cors'
import express from 'express'
import { Transaction, Utils } from '@bsv/sdk'
import { committedSats, fundingPlan, loadBudget } from '@upstream/shared/budget'
import { loadRuntime } from '@upstream/shared/runtime'
import { loadKeys } from '@upstream/shared/keystore'
import type { FundingPlanResponse, FundingScope } from '@upstream/shared/funding'
import { fundingSummaries, fundingTargets, recordFunding, totalSats } from './funding.ts'
import { AttestationError, allAttestations, saveAttestation } from './identity.ts'
import {
  ContributionError,
  allContributions,
  allRejected,
  readPool,
  storeContribution,
  storeRejection,
  tally,
  verifyContribution,
  writePool,
  type ContributionReport
} from './contributions.ts'
import { addClient, clientCount, emit } from './events.ts'
import { ensureDataDir } from './store.ts'
import { settlementRouter } from './settlementRoutes.ts'

// Fail fast on a bad .env rather than part-way through a mainnet transaction.
const runtime = loadRuntime(process.env)
const budget = loadBudget(process.env)

const PORT = runtime.port
const ROUND = runtime.round
const NETWORK = runtime.network
ensureDataDir()

const app = express()

// The web UI runs on its own origin (Vite, port 5173) and calls this server directly.
app.use(cors())
// A 62-output AtomicBEEF is a few hundred kB of hex.
app.use(express.json({ limit: '25mb' }))

const isScope = (v: unknown): v is FundingScope => v === 'lisa' || v === 'all'

/** Keys are read per request so `npm run keys` does not need a restart. */
const keysOrFail = (): ReturnType<typeof loadKeys> => loadKeys()

/** The pool defaults to the budget's pledge until the sponsor sets one. */
const pool = (): number => readPool(budget.sponsorPoolSats)

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'upstream-server',
    round: ROUND,
    network: NETWORK,
    phase: 9,
    pool: pool(),
    contributions: allContributions().length,
    rejected: allRejected().length,
    listeners: clientCount(),
    budget: { ...budget, funding: fundingPlan(budget), committed: committedSats(budget) }
  })
})

/* ------------------------------------------------------------------ Phase 3 */

/**
 * The plan the browser spends to. Addresses and amounts only.
 * `?scope=lisa` is the single-output smoke test; `?scope=all` the full fan-out.
 */
app.get('/funding-plan', (req, res) => {
  const scope = req.query.scope ?? 'all'
  if (!isScope(scope)) {
    res.status(400).json({ error: "scope must be 'lisa' or 'all'" })
    return
  }
  try {
    const targets = fundingTargets(keysOrFail(), budget, scope)
    const body: FundingPlanResponse = {
      scope,
      round: ROUND,
      network: NETWORK,
      targets,
      totalSats: totalSats(targets),
      alreadyFunded: fundingSummaries()
    }
    res.json(body)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * Record a funding transaction the wallet has already broadcast.
 * The AtomicBEEF is saved to `data/` and every output index is resolved to its
 * agent by locking script.
 */
app.post('/funding', (req, res) => {
  const { scope, txid, beefHex } = (req.body ?? {}) as Record<string, unknown>

  if (!isScope(scope)) {
    res.status(400).json({ error: "scope must be 'lisa' or 'all'" })
    return
  }
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    res.status(400).json({ error: 'txid must be 64 hex characters' })
    return
  }
  if (typeof beefHex !== 'string' || beefHex.length === 0) {
    res.status(400).json({ error: 'beefHex is required' })
    return
  }

  try {
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex'))
    if (tx.id('hex') !== txid.toLowerCase()) {
      res.status(400).json({ error: `BEEF is for ${tx.id('hex')}, not ${txid}` })
      return
    }

    const targets = fundingTargets(keysOrFail(), budget, scope)
    const record = recordFunding({
      scope,
      round: ROUND,
      txid: txid.toLowerCase(),
      beefHex,
      tx,
      targets
    })

    console.log(
      `funded ${record.outputs.length} agent(s) with ${record.totalSats} sats · ${record.txid}`
    )
    res.json(record)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

/** Everything recorded so far. */
app.get('/funding', (_req, res) => {
  res.json(fundingSummaries())
})

/**
 * The agent public key an owner should vouch for. The browser signs this with
 * BSV Desktop; the private key never leaves the wallet.
 */
app.get('/agent/lisa', (_req, res) => {
  try {
    const { lisa } = keysOrFail()
    const stored = allAttestations().find(a => a.agentPubKey === lisa.pubKey)
    res.json({
      label: lisa.label,
      agentPubKey: lisa.pubKey,
      address: lisa.address,
      attested: stored ? { ownerPubKey: stored.ownerPubKey, verified: stored.verified } : null
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/** Store the owner's signature over an agent's public key. */
app.post('/attestation', (req, res) => {
  void (async () => {
    const { ownerPubKey, agentPubKey, signature } = (req.body ?? {}) as Record<string, unknown>
    if (
      typeof ownerPubKey !== 'string' ||
      typeof agentPubKey !== 'string' ||
      typeof signature !== 'string'
    ) {
      res.status(400).json({ error: 'ownerPubKey, agentPubKey and signature are required' })
      return
    }
    try {
      const keys = keysOrFail()
      // Only vouch for agents we actually generated.
      const known = [keys.lisa, ...keys.swarm.map(s => s.agent), keys.whale.agent].find(
        k => k.pubKey === agentPubKey
      )
      if (!known) {
        res.status(400).json({ error: 'unknown agent public key' })
        return
      }
      const stored = await saveAttestation(known.label, { ownerPubKey, agentPubKey, signature })
      console.log(`attestation for ${known.label} verified (owner ${ownerPubKey.slice(0, 12)}…)`)
      res.json(stored)
    } catch (err) {
      const status = err instanceof AttestationError ? err.status : 400
      console.warn(`attestation refused: ${(err as Error).message}`)
      res.status(status).json({ error: (err as Error).message })
    }
  })()
})

app.get('/attestation', (_req, res) => {
  res.json(allAttestations())
})

/* ------------------------------------------------------------------ Phase 5 */

/**
 * Report a contribution.
 *
 * Valid → stored and a `contribution` event is emitted.
 * Invalid → nothing is stored and a `rejected` event is emitted, which is how
 * the sybil attack shows up in the galaxy.
 */
app.post('/contribution', (req, res) => {
  void (async () => {
    const report = (req.body ?? {}) as ContributionReport
    try {
      const verified = await verifyContribution(report, { round: ROUND, budget })
      const { stored, isNew } = storeContribution(verified)

      if (isNew) {
        emit({
          type: 'contribution',
          project: stored.project,
          owner: stored.owner,
          sats: stored.sats,
          txid: stored.txid,
          dryRun: stored.dryRun
        })
        emitTally()
        console.log(
          `contribution ${stored.sats} sats → ${stored.project} · owner ${stored.owner.slice(0, 10)}… · ${stored.txid.slice(0, 12)}${stored.dryRun ? ' (dry run)' : ''}`
        )
      }
      res.json({ ...stored, duplicate: !isNew })
    } catch (err) {
      const reason = (err as Error).message
      const status = err instanceof ContributionError ? 400 : 500

      // Keep the refusal, so the demo can show the attack being turned away.
      let txid: string | null = null
      try {
        txid = Transaction.fromHex(report.rawTxHex).id('hex')
      } catch {
        txid = null
      }
      const rejection = storeRejection({
        txid,
        project: typeof report.projectId === 'string' ? report.projectId : null,
        agent: typeof report.agentPubKey === 'string' ? report.agentPubKey : null,
        reason,
        createdAt: new Date().toISOString()
      })

      emit({
        type: 'rejected',
        project: rejection.project ?? 'unknown',
        reason,
        ...(txid !== null ? { txid } : {})
      })
      console.warn(`contribution rejected: ${reason}`)
      res.status(status).json({ error: reason })
    }
  })()
})

app.get('/contribution', (_req, res) => {
  res.json({ contributions: allContributions(), rejected: allRejected() })
})

/** The quadratic matching result for the current round. */
app.get('/tally', (_req, res) => {
  res.json(tally(ROUND, pool()))
})

/** The sponsor sets the matching pool. It stays in their wallet until Phase 9. */
app.post('/pledge', (req, res) => {
  const { pool: requested } = (req.body ?? {}) as Record<string, unknown>
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 0) {
    res.status(400).json({ error: 'pool must be a whole number of satoshis, 0 or more' })
    return
  }
  if (requested > budget.totalBudgetSats) {
    res.status(400).json({
      error: `pool ${requested} exceeds TOTAL_BUDGET_SATS=${budget.totalBudgetSats}`
    })
    return
  }
  const set = writePool(requested)
  const result = tally(ROUND, set)
  emit({ type: 'tally', pool: set, rows: result.rows })
  console.log(`sponsor pledged ${set} sats`)
  res.json(result)
})

/* ------------------------------------------------------------------ Phase 9 */

app.use(settlementRouter({ round: ROUND, network: NETWORK, serverDryRun: runtime.dryRun, pool }))

/** Live stream for the UI. */
app.get('/events', (req, res) => {
  const remove = addClient(res)
  req.on('close', remove)
})

function emitTally(): void {
  const result = tally(ROUND, pool())
  emit({ type: 'tally', pool: result.pool, rows: result.rows })
}

app.listen(PORT, () => {
  console.log(`upstream server listening on http://localhost:${PORT}  (round ${ROUND}, ${NETWORK})`)
  console.log(`agents report to ${runtime.serverUrl} (SERVER_URL)`)
  console.log(`matching pool ${pool()} sats · ${allContributions().length} contribution(s) recorded`)
})
