/**
 * Phase 5 — verifying contributions and running the tally.
 *
 * A contribution is only counted when the transaction itself proves it:
 *   - an output pays the project's address at least CONTRIBUTION_SATS;
 *   - an OP_RETURN carries `UPSTREAM|<round>|<projectId>` for this round and
 *     the same project the paid output belongs to;
 *   - the owner's signature over the agent's public key verifies.
 *
 * The owner, not the agent and not the transaction, is the unit of matching.
 * That is the Sybil defence: an attacker with a hundred agents under one owner
 * counts once, and an attacker with no owner signature counts not at all.
 */
import { P2PKH, Transaction } from '@bsv/sdk'
import { verifyAgentAttestation } from '@upstream/shared/attestation'
import { findContributionTag } from '@upstream/shared/opreturn'
import { quadraticMatch, type C } from '@upstream/shared/quadratic'
import { findProject } from '@upstream/shared/projects'
import type { Budget } from '@upstream/shared/budget'
import type { TallyRow } from '@upstream/shared'
import { dataPath, readJson, writeJson } from './store.ts'

/** What an agent posts after broadcasting a contribution. */
export interface ContributionReport {
  rawTxHex: string
  projectId: string
  agentPubKey: string
  ownerPubKey: string
  ownerSignature: string
  /**
   * True when the agent built and signed the transaction but did not broadcast
   * it (DRY_RUN). Counted in the tally and labelled, so a dry run is never
   * mistaken for settled money.
   */
  dryRun?: boolean
}

/** A verified, counted contribution. */
export interface StoredContribution {
  txid: string
  round: string
  project: string
  /** Owner identity key — the unit of matching. */
  owner: string
  agent: string
  sats: number
  /** Index of the output paying the project, found by locking script. */
  outputIndex: number
  /** True when this contribution was never broadcast. */
  dryRun: boolean
  createdAt: string
}

/** A contribution that was refused, kept so the demo can show the attack. */
export interface RejectedContribution {
  txid: string | null
  project: string | null
  agent: string | null
  reason: string
  createdAt: string
}

const CONTRIBUTIONS = (): string => dataPath('contributions.json')
const REJECTED = (): string => dataPath('rejected.json')
const POOL = (): string => dataPath('pool.json')

export const allContributions = (): StoredContribution[] =>
  readJson<StoredContribution[]>(CONTRIBUTIONS(), [])

export const allRejected = (): RejectedContribution[] =>
  readJson<RejectedContribution[]>(REJECTED(), [])

/** Why a report was refused. The message is shown in the UI, so keep it plain. */
export class ContributionError extends Error {}

// A function declaration, not an arrow: TypeScript only narrows on a
// never-returning call when the callee is declared this way.
function fail(reason: string): never {
  throw new ContributionError(reason)
}

/**
 * Verify a report against the raw transaction.
 *
 * Nothing here trusts the reporter: the project, the amount and the round all
 * come out of the transaction, and `projectId` in the report is only checked
 * for agreement with it.
 */
export async function verifyContribution(
  report: ContributionReport,
  opts: { round: string; budget: Budget }
): Promise<StoredContribution> {
  const { rawTxHex, projectId, agentPubKey, ownerPubKey, ownerSignature } = report

  if (typeof rawTxHex !== 'string' || rawTxHex.length === 0) fail('rawTxHex is required')
  if (typeof projectId !== 'string' || projectId.length === 0) fail('projectId is required')

  let tx: Transaction
  try {
    tx = Transaction.fromHex(rawTxHex)
  } catch (err) {
    return fail(`rawTxHex is not a transaction: ${(err as Error).message}`)
  }
  const txid = tx.id('hex')

  // 1. The project must be one we know, and the claim must match the tag.
  const project = findProject(projectId)
  if (project === undefined) fail(`unknown project "${projectId}"`)

  // 2. The OP_RETURN tag decides the round and the project, not the reporter.
  const tag = findContributionTag(tx)
  if (tag === null) fail('no OP_RETURN carrying UPSTREAM|<round>|<projectId>')
  if (tag.round !== opts.round) {
    fail(`tag is for round "${tag.round}", this server is running "${opts.round}"`)
  }
  if (tag.projectId !== projectId) {
    fail(`tag names project "${tag.projectId}" but the report claims "${projectId}"`)
  }

  // 3. An output must actually pay that project. Found by locking script, so
  //    output order and any change output are irrelevant.
  const want = new P2PKH().lock(project.address).toHex()
  const outputIndex = tx.outputs.findIndex(o => o.lockingScript.toHex() === want)
  if (outputIndex < 0) fail(`no output pays ${projectId} (${project.address})`)

  const sats = tx.outputs[outputIndex]?.satoshis ?? 0
  if (sats < opts.budget.contributionSats) {
    fail(`output ${outputIndex} pays ${sats} sats, below CONTRIBUTION_SATS=${opts.budget.contributionSats}`)
  }

  // 4. The owner must vouch for the agent. No signature, no matching weight.
  if (typeof agentPubKey !== 'string' || agentPubKey.length === 0) fail('agentPubKey is required')
  if (typeof ownerPubKey !== 'string' || ownerPubKey.length === 0) {
    fail('ownerPubKey is required: an agent with no owner earns no matching')
  }
  if (typeof ownerSignature !== 'string' || ownerSignature.length === 0) {
    fail('ownerSignature is required: an agent with no owner earns no matching')
  }
  const vouched = await verifyAgentAttestation({ ownerPubKey, agentPubKey, signature: ownerSignature })
  if (!vouched) fail('the owner signature does not verify for that agent')

  return {
    txid,
    round: tag.round,
    project: projectId,
    owner: ownerPubKey,
    agent: agentPubKey,
    sats,
    outputIndex,
    dryRun: report.dryRun === true,
    createdAt: new Date().toISOString()
  }
}

/**
 * Store a verified contribution. Idempotent on txid + output, so a retried
 * report cannot inflate a project's total.
 */
export function storeContribution(c: StoredContribution): { stored: StoredContribution; isNew: boolean } {
  const existing = allContributions().find(
    x => x.txid === c.txid && x.outputIndex === c.outputIndex
  )
  if (existing) return { stored: existing, isNew: false }
  writeJson(CONTRIBUTIONS(), [...allContributions(), c])
  return { stored: c, isNew: true }
}

export function storeRejection(r: RejectedContribution): RejectedContribution {
  writeJson(REJECTED(), [...allRejected(), r])
  return r
}

/** The sponsor's pledged matching pool. */
export const readPool = (defaultSats: number): number =>
  readJson<{ pool: number }>(POOL(), { pool: defaultSats }).pool

export function writePool(pool: number): number {
  writeJson(POOL(), { pool })
  return pool
}

export interface Tally {
  round: string
  pool: number
  rows: TallyRow[]
  totalRaised: number
  totalMatched: number
  contributions: number
  owners: number
  rejected: number
  /** How many counted contributions were never broadcast. */
  dryRunContributions: number
  /** True when every counted contribution is a dry run. */
  dryRun: boolean
}

/** Run quadratic matching over the verified contributions. */
export function tally(round: string, pool: number): Tally {
  const verified = allContributions().filter(c => c.round === round)
  const contribs: C[] = verified.map(c => ({ project: c.project, owner: c.owner, sats: c.sats }))
  const rows = quadraticMatch(contribs, pool)

  return {
    round,
    pool,
    // Biggest match first: this is what the galaxy and the settlement read.
    rows: [...rows].sort((a, b) => b.match - a.match || b.raised - a.raised),
    totalRaised: verified.reduce((a, c) => a + c.sats, 0),
    totalMatched: rows.reduce((a, r) => a + r.match, 0),
    contributions: verified.length,
    owners: new Set(verified.map(c => c.owner)).size,
    rejected: allRejected().length,
    dryRunContributions: verified.filter(c => c.dryRun).length,
    dryRun: verified.length > 0 && verified.every(c => c.dryRun)
  }
}
