/**
 * BSV Desktop over BRC-100.
 *
 * Connection follows the guide §4: `new WalletClient('auto')` in a browser —
 * BSV Desktop identifies the app by page origin. The second constructor
 * argument is the originator domain, used from Node, not a permission mode.
 *
 * Every signature happens inside the wallet. This app never sees a private key.
 */
import {
  P2PKH,
  Transaction,
  Utils,
  WalletClient,
  type AtomicBEEF,
  type WalletAction
} from '@bsv/sdk'
import { signAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'
import type { FundingTarget } from '@upstream/shared/funding'
import {
  describeWalletError,
  salvageTransaction,
  withWalletTap,
  type WalletExchange
} from './walletErrors'

/**
 * Label on every action we create, so `listActions` can find them again.
 * Appendix A labels every kit action the same way (`labels: ['bsv21']`,
 * `labels: ['ordinals']`); `ListActionsArgs.labels` is required, so an
 * unlabelled action is effectively invisible to the wallet history API.
 */
export const FUNDING_LABEL = 'upstream funding'

export interface Connection {
  wallet: WalletClient
  identityKey: string
  network: string
  /** Spendable satoshis in the default basket, or null if the wallet declined. */
  balance: number | null
}

export async function connect(): Promise<Connection> {
  const wallet = new WalletClient('auto')
  await wallet.waitForAuthentication({})
  const { network } = await wallet.getNetwork({})
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, identityKey, network, balance: await spendableBalance(wallet) }
}

/**
 * Sum of spendable outputs in the default basket (guide §24). Listing baskets
 * is a permission the wallet may not grant, so a refusal is not an error here.
 */
export async function spendableBalance(wallet: WalletClient): Promise<number | null> {
  try {
    const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
    return outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)
  } catch {
    return null
  }
}

/** A wallet failure with everything we could recover about it. */
export class WalletCallError extends Error {
  constructor(
    readonly detail: string,
    /** Set when the wallet signed a transaction before failing. */
    readonly salvaged: { txid: string; beefHex: string } | null,
    readonly exchanges: WalletExchange[]
  ) {
    super(detail.split('\n')[0] ?? 'wallet call failed')
    this.name = 'WalletCallError'
  }
}

export interface FundingResult {
  txid: string
  beefHex: string
  /** Output index per target, resolved by locking script. */
  indexes: Array<{ label: string; index: number }>
}

/**
 * ONE createAction paying every target.
 *
 * Options are exactly those Appendix A uses for an indexed payment:
 * `randomizeOutputs: false` keeps our outputs at the indexes we gave them, and
 * `acceptDelayedBroadcast: false` returns only once the transaction is
 * broadcast, so the BEEF can be handed on at once. We pass neither `noSend`
 * nor `signAndProcess`. Indexes are still resolved by locking script rather
 * than assumed (§6.1).
 */
export async function fundAgents(
  wallet: WalletClient,
  targets: FundingTarget[],
  description: string
): Promise<FundingResult> {
  const outputs = targets.map(t => ({
    lockingScript: new P2PKH().lock(t.address).toHex(),
    satoshis: t.satoshis,
    outputDescription: outputDescriptionFor(t)
  }))

  const { result, error, exchanges } = await withWalletTap(
    async () =>
      await wallet.createAction({
        description,
        labels: [FUNDING_LABEL],
        outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
  )

  if (error !== undefined) {
    const salvage = salvageTransaction(error)
    throw new WalletCallError(
      describeWalletError(error, exchanges),
      salvage === null ? null : { txid: salvage.txid, beefHex: Utils.toHex(salvage.tx) },
      exchanges
    )
  }

  if (result?.sendWithResults?.some(r => r.txid === result.txid && r.status === 'failed')) {
    throw new WalletCallError('The wallet reported a failed broadcast. Check BSV Desktop before retrying.', null, exchanges)
  }
  if (!result?.txid || !result.tx) {
    throw new WalletCallError(
      `The wallet returned no transaction.\nresult: ${JSON.stringify(result)}`,
      null,
      exchanges
    )
  }

  return { txid: result.txid, beefHex: Utils.toHex(result.tx), ...locate(result.tx, targets) }
}

function locate(beef: AtomicBEEF, targets: FundingTarget[]): Pick<FundingResult, 'indexes'> {
  const tx = Transaction.fromAtomicBEEF(beef)
  const scripts = tx.outputs.map(o => o.lockingScript.toHex())
  const taken = new Set<number>()
  const indexes = targets.map(t => {
    const want = new P2PKH().lock(t.address).toHex()
    const index = scripts.findIndex((s, i) => s === want && !taken.has(i))
    if (index >= 0) taken.add(index)
    return { label: t.label, index }
  })
  return { indexes }
}

/** `outputDescription` must be 5–50 bytes (BRC-100). */
function outputDescriptionFor(t: FundingTarget): string {
  const text = `Fund ${t.label}`
  return text.length < 5 ? `Fund agent ${t.label}` : text.slice(0, 50)
}

/** Ask BSV Desktop to vouch for an agent's public key. */
export async function attestAgent(
  wallet: WalletClient,
  agentPubKey: string
): Promise<AgentAttestation> {
  const { result, error, exchanges } = await withWalletTap(
    async () => await signAgentAttestation(wallet, agentPubKey)
  )
  if (error !== undefined || result === undefined) {
    throw new WalletCallError(describeWalletError(error, exchanges), null, exchanges)
  }
  return result
}

/**
 * Statuses that mean the wallet is holding an action it never finished.
 * A funding attempt left in one of these should be cleared before retrying,
 * or its inputs stay reserved.
 */
const STUCK: ReadonlyArray<WalletAction['status']> = ['unsigned', 'nosend', 'failed', 'unprocessed']

export interface ActionReport {
  actions: WalletAction[]
  stuck: WalletAction[]
}

/**
 * Every funding action the wallet remembers, and which of them are unfinished.
 *
 * `ListActionsArgs.labels` is required by BRC-100, which is why we now label
 * our actions. Actions created before the label was added will not appear
 * here — BSV Desktop's own history is the fallback for those.
 */
export async function listFundingActions(wallet: WalletClient): Promise<ActionReport> {
  const { actions } = await wallet.listActions({
    labels: [FUNDING_LABEL],
    labelQueryMode: 'any',
    includeLabels: true,
    includeOutputs: true,
    limit: 100
  })
  return { actions, stuck: actions.filter(a => STUCK.includes(a.status)) }
}
