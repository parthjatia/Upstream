/**
 * Upstream tally server.
 *
 * Phase 1: starts and reports that it is alive. The real routes arrive later:
 *  - Phase 3 POST /funding      save the agent funding transaction
 *  - Phase 5 POST /contribution verify a contribution; GET /tally; POST /pledge; GET /events
 *  - Phase 9 POST /settlement   record the settled round
 */
import cors from 'cors'
import express from 'express'
import { committedSats, fundingPlan, loadBudget } from '@upstream/shared/budget'

const PORT = Number(process.env.PORT ?? 8787)
const ROUND = process.env.ROUND ?? 'round-1'

// Fail fast on a bad .env rather than part-way through a mainnet transaction.
const budget = loadBudget(process.env)

const app = express()

// The web UI runs on its own origin (Vite, port 5173) and calls this server directly.
app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'upstream-server',
    round: ROUND,
    network: process.env.BSV_NETWORK ?? 'mainnet',
    phase: 2,
    budget: {
      ...budget,
      funding: fundingPlan(budget),
      committed: committedSats(budget)
    }
  })
})

app.listen(PORT, () => {
  console.log(`upstream server listening on http://localhost:${PORT}  (round ${ROUND})`)
})
