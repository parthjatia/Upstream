/**
 * Owner attestations — the Sybil defence.
 *
 * Every agent belongs to an owner, and the owner signs the agent's public key.
 * Matching counts owners, so an attacker who spins up a hundred agents under
 * one owner still counts once; an attacker with no owner signature at all is
 * rejected outright.
 *
 * The owner signs with `counterparty: 'anyone'`, which means anyone holding the
 * owner's identity key can verify it without a shared secret:
 *   - Lisa's owner is BSV Desktop (`createSignature` in the browser, the key
 *     never leaves the wallet);
 *   - swarm owners are simulated with the SDK's `ProtoWallet` (Phase 7);
 *   - the verifier is `ProtoWallet('anyone')`, which derives the owner's public
 *     key from `counterparty: ownerPubKey`.
 *
 * Isomorphic: ProtoWallet is pure crypto, so this runs in the browser and in Node.
 */
import { ProtoWallet, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

/**
 * Security level 1: the wallet asks once per app. Level 0 would never prompt,
 * which is wrong for a key that vouches for who gets matched.
 * BRC-43 requires at least 5 characters, letters, digits and spaces only.
 */
export const AGENT_ATTESTATION_PROTOCOL: WalletProtocol = [1, 'upstream agent']
export const AGENT_ATTESTATION_KEY_ID = 'agent'

/** The bytes an owner signs: the agent's compressed public key. */
export const agentAttestationData = (agentPubKey: string): number[] =>
  Utils.toArray(agentPubKey, 'hex')

/** An owner's signature over one agent's public key. */
export interface AgentAttestation {
  /** The owner's identity public key. */
  ownerPubKey: string
  /** The agent's public key, which is what was signed. */
  agentPubKey: string
  /** DER signature, hex. */
  signature: string
}

/**
 * Ask a wallet to vouch for an agent. Used in the browser with a `WalletClient`
 * talking to BSV Desktop, and in Node with a `ProtoWallet` for simulated owners.
 * The private key never leaves the wallet.
 */
export async function signAgentAttestation(
  wallet: Pick<WalletInterface, 'createSignature' | 'getPublicKey'>,
  agentPubKey: string,
  originator?: string
): Promise<AgentAttestation> {
  const { publicKey: ownerPubKey } = await wallet.getPublicKey({ identityKey: true }, originator)
  const { signature } = await wallet.createSignature(
    {
      data: agentAttestationData(agentPubKey),
      protocolID: AGENT_ATTESTATION_PROTOCOL,
      keyID: AGENT_ATTESTATION_KEY_ID,
      counterparty: 'anyone'
    },
    originator
  )
  return { ownerPubKey, agentPubKey, signature: Utils.toHex(signature) }
}

/**
 * Check an attestation with the owner's identity key alone. Returns false
 * rather than throwing, so one malformed report cannot take the server down.
 */
export async function verifyAgentAttestation(att: AgentAttestation): Promise<boolean> {
  try {
    const anyone = new ProtoWallet('anyone')
    const { valid } = await anyone.verifySignature({
      data: agentAttestationData(att.agentPubKey),
      signature: Utils.toArray(att.signature, 'hex'),
      protocolID: AGENT_ATTESTATION_PROTOCOL,
      keyID: AGENT_ATTESTATION_KEY_ID,
      counterparty: att.ownerPubKey
    })
    return valid
  } catch {
    return false
  }
}
