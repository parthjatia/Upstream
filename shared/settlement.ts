/**
 * Phase 9 — the settlement transaction, as pure functions.
 *
 * Lives in `shared/` because both sides need it and neither owns it: the server
 * builds the preview with it, and the web panel uses the SAME code to rebuild
 * the outputs from the results JSON before handing them to BSV Desktop. The
 * browser therefore never signs a locking script it merely received from the
 * server — it signs what it derived itself from the project registry and the
 * results it can read.
 *
 * Browser-safe on purpose: no `node:` imports, so it is reachable from the
 * package root and bundles cleanly.
 *
 * The settlement transaction is:
 *   - one P2PKH output per project with `match > 0`, to that project's address
 *     in `shared/projects.json`, for exactly `match` satoshis;
 *   - one `OP_FALSE OP_RETURN` output carrying
 *       "UPSTREAM-SETTLE" | <round> | SHA-256(results JSON)   (three pushes).
 *
 * The results JSON is canonical (fixed key order, rows sorted by project id,
 * integers only), so anyone holding it can recompute the hash and check it
 * against the chain.
 */
import { Hash, OP, P2PKH, Script, Utils, type Transaction } from '@bsv/sdk'
import { findProject } from '@upstream/shared/projects'

/** First push of the settlement OP_RETURN. */
export const SETTLE_PREFIX = 'UPSTREAM-SETTLE'

/** Label on the wallet action, so `listActions` can find it again. */
export const SETTLEMENT_LABEL = 'upstream settlement'

/** Bumped if the results format ever changes. */
export const RESULTS_VERSION = 1

/** The minimum a tally row must carry to be settled. */
export interface SettleableRow {
  project: string
  raised: number
  supporters: number
  match: number
}

/** The input to the canonical results document. */
export interface RoundSummary {
  round: string
  network: string
  pool: number
  rows: SettleableRow[]
  /** Verified contribution txids. Sorted and de-duplicated in the document. */
  contributionTxids: string[]
  owners: number
  dryRunContributions: number
}

/** One row of the results document. */
export interface ResultRow {
  project: string
  address: string
  raised: number
  supporters: number
  match: number
}

/** The document whose SHA-256 goes on chain. */
export interface RoundResults {
  kind: 'upstream-round-results'
  version: number
  round: string
  network: string
  pool: number
  totalRaised: number
  totalMatched: number
  owners: number
  contributions: number
  dryRunContributions: number
  rows: ResultRow[]
  contributionTxids: string[]
}

/** One output, in the shape `createAction` takes. */
export interface SettlementOutput {
  kind: 'project' | 'data'
  /** Project id for `kind: 'project'`. */
  project?: string
  address?: string
  lockingScript: string
  satoshis: number
  /** 5–50 bytes (BRC-100). */
  outputDescription: string
}

export class SettlementError extends Error {}

function fail(reason: string): never {
  throw new SettlementError(reason)
}

const isWholeSats = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/**
 * Build the canonical results document.
 *
 * Every project in the tally is listed (matched or not), so the document is a
 * full account of the round. Key order is fixed by construction here, which is
 * what makes `JSON.stringify` canonical.
 */
export function buildResults(s: RoundSummary): RoundResults {
  const rows: ResultRow[] = [...s.rows]
    .sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0))
    .map(r => {
      const project = findProject(r.project) ?? fail(`unknown project "${r.project}" in the tally`)
      for (const [name, v] of [
        ['raised', r.raised],
        ['supporters', r.supporters],
        ['match', r.match]
      ] as const) {
        if (!isWholeSats(v)) fail(`${r.project}: ${name} must be a whole number, got ${String(v)}`)
      }
      return {
        project: r.project,
        address: project.address,
        raised: r.raised,
        supporters: r.supporters,
        match: r.match
      }
    })

  const totalMatched = rows.reduce((a, r) => a + r.match, 0)
  if (!isWholeSats(s.pool)) fail(`pool must be a whole number, got ${String(s.pool)}`)
  if (totalMatched > s.pool) fail(`matches total ${totalMatched}, more than the pool of ${s.pool}`)

  const contributionTxids = [...new Set(s.contributionTxids.map(t => t.toLowerCase()))].sort()

  return {
    kind: 'upstream-round-results',
    version: RESULTS_VERSION,
    round: s.round,
    network: s.network,
    pool: s.pool,
    totalRaised: rows.reduce((a, r) => a + r.raised, 0),
    totalMatched,
    owners: s.owners,
    contributions: contributionTxids.length,
    dryRunContributions: s.dryRunContributions,
    rows,
    contributionTxids
  }
}

/** The exact bytes that are hashed: compact JSON, UTF-8. */
export const resultsJsonOf = (r: RoundResults): string => JSON.stringify(r)

/** SHA-256 of the results JSON, hex. */
export const resultsHash = (resultsJson: string): string =>
  Utils.toHex(Hash.sha256(Utils.toArray(resultsJson, 'utf8')))

/** `OP_FALSE OP_RETURN "UPSTREAM-SETTLE" <round> <sha256>` */
export function settlementDataScript(round: string, hashHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hashHex)) fail('hash must be 32 bytes of lowercase hex')
  if (round.length === 0) fail('round must not be empty')
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(SETTLE_PREFIX, 'utf8'))
    .writeBin(Utils.toArray(round, 'utf8'))
    .writeBin(Utils.toArray(hashHex, 'hex'))
    .toHex()
}

/** Parse a results JSON string and check it is shaped like ours. */
export function parseResults(resultsJson: string): RoundResults {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultsJson)
  } catch (err) {
    return fail(`results JSON does not parse: ${(err as Error).message}`)
  }
  const r = parsed as Partial<RoundResults>
  if (r.kind !== 'upstream-round-results') fail('not an Upstream round results document')
  if (r.version !== RESULTS_VERSION) fail(`unsupported results version ${String(r.version)}`)
  if (typeof r.round !== 'string' || !Array.isArray(r.rows)) fail('results document is incomplete')
  return r as RoundResults
}

/**
 * The outputs of the settlement transaction, derived from the results JSON.
 *
 * Addresses come from the project REGISTRY, never from the document: a
 * document naming a different address for a project is refused, so a tampered
 * preview cannot redirect the pool.
 */
export function settlementOutputs(resultsJson: string): SettlementOutput[] {
  const results = parseResults(resultsJson)
  const outputs: SettlementOutput[] = []

  for (const row of results.rows) {
    if (!isWholeSats(row.match)) fail(`${row.project}: match must be a whole number`)
    if (row.match === 0) continue
    const project = findProject(row.project) ?? fail(`unknown project "${row.project}"`)
    if (row.address !== project.address) {
      fail(`${row.project}: results name ${row.address}, the registry says ${project.address}`)
    }
    outputs.push({
      kind: 'project',
      project: project.id,
      address: project.address,
      lockingScript: new P2PKH().lock(project.address).toHex(),
      satoshis: row.match,
      outputDescription: `Match ${project.id}`.slice(0, 50)
    })
  }

  outputs.push({
    kind: 'data',
    lockingScript: settlementDataScript(results.round, resultsHash(resultsJson)),
    satoshis: 0,
    outputDescription: 'Round results hash'
  })
  return outputs
}

/** Read `<round, hash>` out of a settlement OP_RETURN, or null. */
export function readSettlementScript(script: Script): { round: string; hash: string } | null {
  const chunks = script.chunks
  if (chunks[0]?.op !== OP.OP_FALSE || chunks[1]?.op !== OP.OP_RETURN) return null

  // As in shared/opreturn.ts: the SDK hands back everything after OP_RETURN as
  // one blob on that chunk, so re-parse it into pushes. Separate chunks are
  // accepted too.
  const pushes: number[][] = []
  const blob = chunks[1]?.data
  if (blob !== undefined && blob.length > 0) {
    try {
      for (const inner of Script.fromBinary(blob).chunks) {
        if (inner.data !== undefined) pushes.push(inner.data)
      }
    } catch {
      return null
    }
  }
  for (const c of chunks.slice(2)) if (c.data !== undefined) pushes.push(c.data)

  const [prefix, round, hash] = pushes
  if (prefix === undefined || round === undefined || hash === undefined) return null
  if (Utils.toUTF8(prefix) !== SETTLE_PREFIX || hash.length !== 32) return null
  return { round: Utils.toUTF8(round), hash: Utils.toHex(hash) }
}

/**
 * Check that a transaction is the settlement described by `resultsJson`:
 * every project output present with the exact amount (found by locking script,
 * never by index) and the OP_RETURN carrying that document's hash.
 * Returns the index of each expected output.
 */
export function checkSettlementTx(
  tx: Transaction,
  resultsJson: string
): { indexes: Array<{ project: string | null; index: number }>; hash: string } {
  const expected = settlementOutputs(resultsJson)
  const hash = resultsHash(resultsJson)
  const taken = new Set<number>()

  const indexes = expected.map(o => {
    const index = tx.outputs.findIndex(
      (out, i) =>
        !taken.has(i) && out.lockingScript.toHex() === o.lockingScript && out.satoshis === o.satoshis
    )
    if (index < 0) {
      fail(
        o.kind === 'data'
          ? 'the transaction has no OP_RETURN with this round results hash'
          : `no output pays ${o.project} exactly ${o.satoshis} sats`
      )
    }
    taken.add(index)
    return { project: o.project ?? null, index }
  })

  return { indexes, hash }
}
