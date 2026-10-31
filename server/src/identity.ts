/**
 * Owner attestations saved for the identity rule (Phase 5 enforces it).
 *
 * Lisa's owner is her BSV Desktop identity key; the browser asks the wallet to
 * sign her agent's public key and posts the signature here. We verify on
 * arrival and store only what verifies, so a broken or forged attestation is
 * caught now rather than mid-demo — and cannot displace a good one.
 */
import { verifyAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'
import { dataPath, readJson, writeJson } from './store.ts'

export interface StoredAttestation extends AgentAttestation {
  /** Which agent this vouches for, e.g. "lisa-agent". */
  label: string
  verified: true
  createdAt: string
}

/** Why an attestation was refused. */
export class AttestationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409
  ) {
    super(message)
  }
}

const FILE = (): string => dataPath('attestations.json')

export const allAttestations = (): StoredAttestation[] =>
  readJson<StoredAttestation[]>(FILE(), [])

export const findAttestation = (agentPubKey: string): StoredAttestation | undefined =>
  allAttestations().find(a => a.agentPubKey === agentPubKey)

/**
 * Verify and store an attestation.
 *
 * Refuses a signature that does not verify, and refuses to re-assign an agent
 * to a different owner: an agent has exactly one owner, and letting a later
 * POST overwrite that would hand an attacker Lisa's matching weight. The same
 * owner re-signing is idempotent.
 */
export async function saveAttestation(
  label: string,
  att: AgentAttestation
): Promise<StoredAttestation> {
  if (!(await verifyAgentAttestation(att))) {
    throw new AttestationError('signature does not verify for that owner and agent', 400)
  }

  const existing = findAttestation(att.agentPubKey)
  if (existing && existing.ownerPubKey !== att.ownerPubKey) {
    throw new AttestationError(
      `${label} is already vouched for by ${existing.ownerPubKey.slice(0, 12)}…; ` +
        'an agent has one owner',
      409
    )
  }

  const stored: StoredAttestation = {
    ...att,
    label,
    verified: true,
    createdAt: new Date().toISOString()
  }
  const rest = allAttestations().filter(a => a.agentPubKey !== att.agentPubKey)
  writeJson(FILE(), [...rest, stored])
  return stored
}
