/**
 * The contribution hook: an agent pays a project for using it.
 *
 * One transaction, three outputs, as PROJECT_BRIEF.md Phase 4 specifies:
 *   0  P2PKH to the project        CONTRIBUTION_SATS
 *   1  OP_RETURN                   UPSTREAM|<round>|<projectId>
 *   2  change back to the agent     (becomes the agent's next input)
 *
 * The same code runs in both modes. Dry-run differs in exactly one place — the
 * broadcast is skipped — so going live is flipping DRY_RUN, not taking a
 * different path. Either way the transaction is really built, the fee is really
 * computed, the agent really signs, and the SDK really checks the result.
 */
import {
  P2PKH,
  PrivateKey,
  ProtoWallet,
  SatoshisPerKilobyte,
  Script,
  Spend,
  Transaction,
  Utils
} from '@bsv/sdk'
import { signAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'
import { contributionScript } from '@upstream/shared/opreturn'
import { findProject } from '@upstream/shared/projects'
import type { Budget } from '@upstream/shared/budget'
import type { Runtime } from '@upstream/shared/runtime'
import { getUtxo, putUtxo, sourceTransaction, type AgentUtxo } from './utxos.ts'

/** Satoshis per kilobyte. BSV fees are tiny; 1 sat/kB covers a 250-byte tx. */
export const FEE_RATE = 1

/** Below this a change output costs more to make than it is worth. */
export const DUST_LIMIT = 1

export interface ContributionRequest {
  /** Key label of the paying agent, e.g. "lisa-agent". */
  agentLabel: string
  /** The agent's signing key. */
  agentKey: PrivateKey
  projectId: string
  /** Defaults to the budget's CONTRIBUTION_SATS. */
  sats?: number
  /**
   * The owner that vouches for this agent. Omitted for a sybil, which is how
   * the server comes to reject it.
   */
  owner?: PrivateKey
  /** A ready-made attestation, e.g. Lisa's, signed by BSV Desktop. */
  attestation?: AgentAttestation
}

export interface ContributionResult {
  txid: string
  rawTxHex: string
  projectId: string
  sats: number
  fee: number
  /** The agent's remaining balance, now sitting in the change output. */
  change: number
  dryRun: boolean
  broadcast: boolean
  /** Null when the server refused it, with the reason. */
  accepted: boolean
  serverMessage: string
  explorerUrl: string
}

export class ContributeError extends Error {}

/**
 * Build, sign, check, optionally broadcast, chain the change and report.
 */
export async function contribute(
  req: ContributionRequest,
  opts: { budget: Budget; runtime: Runtime }
): Promise<ContributionResult> {
  const { budget, runtime } = opts
  const amount = req.sats ?? budget.contributionSats

  const project = findProject(req.projectId)
  // A sybil may name a project that does not exist; let it try, and let the
  // server be the thing that says no.
  const payTo = project?.address

  const utxo = getUtxo(req.agentLabel)
  if (utxo === undefined) {
    throw new ContributeError(
      `${req.agentLabel} has no spendable output. ` +
        (runtime.dryRun
          ? 'Run `npm run seed-agents` to give the agents dry-run coins.'
          : 'Fund the agents first, or run `npm run import-funding <txid>`.')
    )
  }
  if (utxo.satoshis <= amount) {
    throw new ContributeError(
      `${req.agentLabel} holds ${utxo.satoshis} sats, not enough to pay ${amount} plus a fee.`
    )
  }

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: sourceTransaction(utxo),
    sourceOutputIndex: utxo.vout,
    unlockingScriptTemplate: new P2PKH().unlock(req.agentKey)
  })

  // 0: the payment. A sybil's invented project pays its own address instead,
  // which still produces a real transaction for the server to reject.
  tx.addOutput({
    lockingScript: new P2PKH().lock(payTo ?? req.agentKey.toAddress([0x00])),
    satoshis: amount
  })
  // 1: the tag that makes the round auditable from the chain alone.
  tx.addOutput({
    lockingScript: Script.fromHex(contributionScript(runtime.round, req.projectId)),
    satoshis: 0
  })
  // 2: change, which becomes this agent's next input.
  tx.addOutput({ lockingScript: new P2PKH().lock(req.agentKey.toAddress([0x00])), change: true })

  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const changeOutput = tx.outputs[2]
  const change = changeOutput?.satoshis ?? 0
  const fee = utxo.satoshis - amount - change
  if (fee < 0) {
    throw new ContributeError(`fee came out negative (${fee}); refusing to continue`)
  }

  // Check our own work with the SDK before anything leaves the machine.
  assertSpendable(tx, utxo)

  const rawTxHex = tx.toHex()
  const txid = tx.id('hex')

  let broadcast = false
  if (!runtime.dryRun) {
    await broadcastToArcade(tx, runtime)
    broadcast = true
  }

  // The change becomes the agent's next input, in both modes. Chaining
  // unconfirmed transactions is normal on BSV.
  if (change > DUST_LIMIT) {
    putUtxo({
      agent: req.agentLabel,
      txid,
      vout: 2,
      satoshis: change,
      lockingScriptHex: new P2PKH().lock(req.agentKey.toAddress([0x00])).toHex(),
      sourceTxHex: rawTxHex,
      synthetic: utxo.synthetic,
      origin: 'change',
      updatedAt: new Date().toISOString()
    })
  }

  const attestation = await resolveAttestation(req)
  const report = await reportContribution(
    {
      rawTxHex,
      projectId: req.projectId,
      agentPubKey: req.agentKey.toPublicKey().toString(),
      ownerPubKey: attestation?.ownerPubKey ?? '',
      ownerSignature: attestation?.signature ?? '',
      dryRun: runtime.dryRun
    },
    runtime
  )

  return {
    txid,
    rawTxHex,
    projectId: req.projectId,
    sats: amount,
    fee,
    change,
    dryRun: runtime.dryRun,
    broadcast,
    accepted: report.accepted,
    serverMessage: report.message,
    explorerUrl: `${runtime.explorerTxUrl}${txid}`
  }
}

/**
 * Evaluate the input's unlocking script against the output it spends.
 *
 * `tx.verify('scripts only')` walks the whole ancestry, which a synthetic
 * funding transaction cannot satisfy, so check the one script that is ours.
 * This is a genuine signature and script check: tampering with any output
 * afterwards makes it fail.
 */
export function assertSpendable(tx: Transaction, utxo: AgentUtxo): void {
  const input = tx.inputs[0]
  if (input?.unlockingScript === undefined) {
    throw new ContributeError('the transaction was not signed')
  }

  const spend = new Spend({
    sourceTXID: input.sourceTXID ?? utxo.txid,
    sourceOutputIndex: utxo.vout,
    sourceSatoshis: utxo.satoshis,
    lockingScript: Script.fromHex(utxo.lockingScriptHex),
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs,
    inputIndex: 0,
    unlockingScript: input.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime
  })

  let valid = false
  try {
    valid = spend.validate()
  } catch (err) {
    throw new ContributeError(`the signed transaction does not validate: ${(err as Error).message}`)
  }
  if (!valid) throw new ContributeError('the signed transaction does not validate')

  const out = tx.outputs.reduce((a, o) => a + (o.satoshis ?? 0), 0)
  if (out > utxo.satoshis) {
    throw new ContributeError(`outputs (${out}) exceed the input (${utxo.satoshis})`)
  }
}

/**
 * Broadcast to Arcade, which expects Extended Format rather than BEEF (§20.1).
 * Only reached when DRY_RUN is false.
 */
export async function broadcastToArcade(tx: Transaction, runtime: Runtime): Promise<void> {
  const res = await fetch(`${runtime.arcadeUrl}/tx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawTx: tx.toHexEF() })
  })
  const text = await res.text()
  if (!res.ok) {
    throw new ContributeError(`Arcade refused ${tx.id('hex')} (${res.status}): ${text.slice(0, 300)}`)
  }
}

/** The owner's signature over the agent's public key, if the agent has an owner. */
async function resolveAttestation(req: ContributionRequest): Promise<AgentAttestation | null> {
  if (req.attestation !== undefined) return req.attestation
  if (req.owner === undefined) return null
  return await signAgentAttestation(
    new ProtoWallet(req.owner),
    req.agentKey.toPublicKey().toString()
  )
}

/** Tell the tally server. A refusal is information, not a crash. */
async function reportContribution(
  body: Record<string, unknown>,
  runtime: Runtime
): Promise<{ accepted: boolean; message: string }> {
  try {
    const res = await fetch(`${runtime.serverUrl}/contribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null
    if (!res.ok) {
      return {
        accepted: false,
        message: (parsed as { error?: string } | null)?.error ?? `server returned ${res.status}`
      }
    }
    const duplicate = (parsed as { duplicate?: boolean } | null)?.duplicate === true
    return { accepted: true, message: duplicate ? 'already counted' : 'counted' }
  } catch (err) {
    return { accepted: false, message: `could not reach the server: ${(err as Error).message}` }
  }
}

/**
 * `paidTool` — pay the project first, then run the tool.
 *
 * This is the whole idea in one function: using an open-source library costs a
 * few satoshis, charged automatically at the moment of use. The payment is a
 * precondition, so a tool whose payment fails does not run.
 */
export function paidTool<Args extends unknown[], R>(
  projectId: string,
  fn: (...args: Args) => R,
  req: Omit<ContributionRequest, 'projectId'>,
  opts: { budget: Budget; runtime: Runtime; onPaid?: (r: ContributionResult) => void }
): (...args: Args) => Promise<R> {
  return async (...args: Args): Promise<R> => {
    const paid = await contribute({ ...req, projectId }, opts)
    opts.onPaid?.(paid)
    return fn(...args)
  }
}

/** Short hex of a txid, for logs. */
export const short = (txid: string): string => txid.slice(0, 12)

/** Re-exported so scripts need not import the SDK for one helper. */
export const toHex = Utils.toHex
