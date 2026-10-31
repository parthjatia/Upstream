/**
 * BSV Desktop over BRC-100.
 *
 * Connection follows the guide §4: `new WalletClient('auto')` in a browser —
 * BSV Desktop identifies the app by page origin. The second constructor
 * argument is the originator domain, used from Node, not a permission mode.
 *
 * Every signature happens inside the wallet. This app never sees a private key.
 */
import { P2PKH, Transaction, Utils, WalletClient } from '@bsv/sdk'
import { signAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'
import type { FundingTarget } from '@upstream/shared/funding'

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

export interface FundingResult {
  txid: string
  beefHex: string
  /** Output index per target, resolved by locking script. */
  indexes: Array<{ label: string; index: number }>
}

/**
 * ONE createAction paying every target.
 *
 * `randomizeOutputs: false` keeps our outputs at the indexes we gave them, and
 * `acceptDelayedBroadcast: false` means the call returns only once the
 * transaction is broadcast, so the BEEF can be handed on immediately.
 * Indexes are still resolved by locking script rather than assumed (§6.1).
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

  const result = await wallet.createAction({
    description,
    outputs,
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })

  if (!result.txid || !result.tx) {
    throw new Error('the wallet returned no transaction')
  }

  const tx = Transaction.fromAtomicBEEF(result.tx)
  const scripts = tx.outputs.map(o => o.lockingScript.toHex())
  const taken = new Set<number>()
  const indexes = targets.map(t => {
    const want = new P2PKH().lock(t.address).toHex()
    const index = scripts.findIndex((s, i) => s === want && !taken.has(i))
    if (index >= 0) taken.add(index)
    return { label: t.label, index }
  })

  return { txid: result.txid, beefHex: Utils.toHex(result.tx), indexes }
}

/** `outputDescription` must be 5–50 bytes (BRC-100). */
function outputDescriptionFor(t: FundingTarget): string {
  const text = `Fund ${t.label}`
  return text.length < 5 ? `Fund agent ${t.label}` : text.slice(0, 50)
}

/** Ask BSV Desktop to vouch for an agent's public key. */
export const attestAgent = async (
  wallet: WalletClient,
  agentPubKey: string
): Promise<AgentAttestation> => await signAgentAttestation(wallet, agentPubKey)
