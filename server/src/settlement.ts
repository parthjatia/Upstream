/**
 * Phase 9 — settling the round.
 *
 * The sponsor's pool never touches this server: the preview tells the browser
 * what to pay, BSV Desktop pays it from the sponsor's own wallet, and the
 * browser reports the broadcast transaction back here to be recorded and
 * announced. Nothing here holds or asks for a key.
 */
import { Transaction, Utils } from '@bsv/sdk'
import { allContributions, tally } from './contributions.ts'
import { dataPath, readJson, writeJson } from './store.ts'
import {
  SettlementError,
  buildResults,
  checkSettlementTx,
  parseResults,
  resultsHash,
  resultsJsonOf,
  settlementOutputs,
  type RoundResults,
  type SettlementOutput
} from './settlementCore.ts'

export { SettlementError } from './settlementCore.ts'

/** What `GET /settlement/preview` returns. */
export interface SettlementPreview {
  round: string
  network: string
  pool: number
  /** True when the server runs with DRY_RUN (agents never broadcast). */
  serverDryRun: boolean
  /** Counted contributions that were never broadcast. */
  dryRunContributions: number
  /** The exact string whose SHA-256 goes on chain. */
  resultsJson: string
  results: RoundResults
  resultsHash: string
  /** Project outputs first (sorted by project id), then the OP_RETURN. */
  outputs: SettlementOutput[]
  /** Satoshis leaving the sponsor's wallet, before the fee. */
  totalSats: number
  /** False when there is nothing to pay; `reason` says why. */
  settleable: boolean
  reason: string | null
  /** A settlement already recorded for this round, if any. */
  settled: SettlementRecord | null
  /** Plain-language cautions for the UI. */
  warnings: string[]
}

/** A settlement the wallet broadcast and the browser reported. */
export interface SettlementRecord {
  round: string
  txid: string
  resultsHash: string
  resultsJson: string
  totalSats: number
  outputs: Array<{ project: string | null; index: number; satoshis: number }>
  /** False when the tally moved on between preview and broadcast. */
  matchesCurrentTally: boolean
  beefHex: string
  createdAt: string
}

const SETTLEMENTS = (): string => dataPath('settlements.json')

export const allSettlements = (): SettlementRecord[] =>
  readJson<SettlementRecord[]>(SETTLEMENTS(), [])

export const settlementFor = (round: string): SettlementRecord | null =>
  allSettlements().find(s => s.round === round) ?? null

export function previewSettlement(opts: {
  round: string
  network: string
  pool: number
  serverDryRun: boolean
}): SettlementPreview {
  const t = tally(opts.round, opts.pool)
  const counted = allContributions().filter(c => c.round === opts.round)

  const results = buildResults({
    round: opts.round,
    network: opts.network,
    pool: t.pool,
    rows: t.rows,
    contributionTxids: counted.map(c => c.txid),
    owners: t.owners,
    dryRunContributions: t.dryRunContributions
  })
  const resultsJson = resultsJsonOf(results)
  const outputs = settlementOutputs(resultsJson)
  const totalSats = outputs.reduce((a, o) => a + o.satoshis, 0)
  const settled = settlementFor(opts.round)

  let reason: string | null = null
  if (settled !== null) reason = `round ${opts.round} was already settled in ${settled.txid}`
  else if (totalSats === 0) {
    reason =
      t.contributions === 0
        ? 'no verified contributions yet'
        : 'no project has a match above 0 (matching needs at least two supporters per project)'
  }

  const warnings: string[] = []
  if (t.dryRunContributions > 0) {
    warnings.push(
      `${t.dryRunContributions} of ${t.contributions} counted contribution(s) were dry runs and never broadcast. Settling pays REAL satoshis for them.`
    )
  }
  if (opts.serverDryRun) {
    warnings.push('The server is in DRY_RUN mode: agent payments are not being broadcast.')
  }

  return {
    round: opts.round,
    network: opts.network,
    pool: t.pool,
    serverDryRun: opts.serverDryRun,
    dryRunContributions: t.dryRunContributions,
    resultsJson,
    results,
    resultsHash: resultsHash(resultsJson),
    outputs,
    totalSats,
    settleable: reason === null,
    reason,
    settled,
    warnings
  }
}

/**
 * Record a settlement the wallet already broadcast.
 *
 * The browser sends the results JSON it signed against. The transaction must
 * pay exactly what that document says and carry its hash; the document's
 * rows must name the registry's addresses (checked in `settlementOutputs`).
 * Whether it still equals the live tally is recorded, not enforced — the money
 * has moved either way, and the record must say what actually happened.
 */
export function recordSettlement(
  body: { txid?: unknown; beefHex?: unknown; resultsJson?: unknown },
  current: { round: string; resultsJson: string }
): SettlementRecord {
  const { txid, beefHex, resultsJson } = body
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new SettlementError('txid must be 64 hex characters')
  }
  if (typeof beefHex !== 'string' || beefHex.length === 0) {
    throw new SettlementError('beefHex is required')
  }
  if (typeof resultsJson !== 'string' || resultsJson.length === 0) {
    throw new SettlementError('resultsJson is required')
  }

  const results = parseResults(resultsJson)
  if (results.round !== current.round) {
    throw new SettlementError(`results are for round "${results.round}", this server runs "${current.round}"`)
  }

  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex'))
  } catch (err) {
    throw new SettlementError(`beefHex is not AtomicBEEF: ${(err as Error).message}`)
  }
  if (tx.id('hex') !== txid.toLowerCase()) {
    throw new SettlementError(`BEEF is for ${tx.id('hex')}, not ${txid}`)
  }

  const { indexes, hash } = checkSettlementTx(tx, resultsJson)

  const existing = allSettlements().find(s => s.txid === txid.toLowerCase())
  if (existing) return existing

  const record: SettlementRecord = {
    round: results.round,
    txid: txid.toLowerCase(),
    resultsHash: hash,
    resultsJson,
    totalSats: results.totalMatched,
    outputs: indexes.map(i => ({
      project: i.project,
      index: i.index,
      satoshis: tx.outputs[i.index]?.satoshis ?? 0
    })),
    matchesCurrentTally: resultsJson === current.resultsJson,
    beefHex,
    createdAt: new Date().toISOString()
  }
  writeJson(SETTLEMENTS(), [...allSettlements(), record])
  return record
}
