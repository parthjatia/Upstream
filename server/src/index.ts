/**
 * Upstream tally server.
 *
 * Phase 3: owns the funding plan (it is the only side that can read `keys/`),
 * records the funding transactions BSV Desktop broadcasts, and stores owner
 * attestations. It never holds, asks for, or returns a private key.
 *
 * Later phases add:
 *  - Phase 5 POST /contribution, GET /tally, POST /pledge, GET /events
 *  - Phase 9 POST /settlement
 */
import cors from 'cors'
import express from 'express'
import { Transaction, Utils } from '@bsv/sdk'
import { committedSats, fundingPlan, loadBudget } from '@upstream/shared/budget'
import { loadKeys } from '@upstream/shared/keystore'
import type { FundingPlanResponse, FundingScope } from '@upstream/shared/funding'
import {
  fundingSummaries,
  fundingTargets,
  recordFunding,
  totalSats
} from './funding.ts'
import { AttestationError, allAttestations, saveAttestation } from './identity.ts'
import { ensureDataDir } from './store.ts'

const PORT = Number(process.env.PORT ?? 8787)
const ROUND = process.env.ROUND ?? 'round-1'
const NETWORK = process.env.BSV_NETWORK ?? 'mainnet'

// Fail fast on a bad .env rather than part-way through a mainnet transaction.
const budget = loadBudget(process.env)
ensureDataDir()

const app = express()

// The web UI runs on its own origin (Vite, port 5173) and calls this server directly.
app.use(cors())
// A 62-output AtomicBEEF is a few hundred kB of hex.
app.use(express.json({ limit: '25mb' }))

const isScope = (v: unknown): v is FundingScope => v === 'lisa' || v === 'all'

/** Keys are read per request so `npm run keys` does not need a restart. */
const keysOrFail = (): ReturnType<typeof loadKeys> => loadKeys()

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'upstream-server',
    round: ROUND,
    network: NETWORK,
    phase: 3,
    budget: { ...budget, funding: fundingPlan(budget), committed: committedSats(budget) }
  })
})

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
    const record = recordFunding({ scope, round: ROUND, txid: txid.toLowerCase(), beefHex, tx, targets })

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

app.listen(PORT, () => {
  console.log(`upstream server listening on http://localhost:${PORT}  (round ${ROUND}, ${NETWORK})`)
})
