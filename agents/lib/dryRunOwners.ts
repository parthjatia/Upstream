/**
 * Simulated owners, for dry-run only.
 *
 * Lisa's real owner is her BSV Desktop identity key, which the wallet signs
 * with in the browser. While the wallet is unavailable, dry-run needs some
 * owner or every contribution is correctly rejected for having none — and then
 * nothing downstream can be exercised.
 *
 * These keys live in gitignored `data/`, never in `keys/`, and are never posted
 * to `POST /attestation`. They are passed inline with a contribution instead,
 * so they leave no stored attestation behind to collide with the real one when
 * BSV Desktop finally signs. A real attestation always takes precedence.
 */
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { signAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'
import { DATA_DIR } from '@upstream/shared/keystore'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = (): string => process.env.UPSTREAM_DATA_DIR ?? DATA_DIR
const file = (): string => join(dataDir(), 'dry-run-owners.json')

/** agent label -> owner private key hex. Dry-run only. */
type Owners = Record<string, string>

function read(): Owners {
  const path = file()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Owners
  } catch {
    return {}
  }
}

function write(owners: Owners): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(file(), `${JSON.stringify(owners, null, 2)}\n`, 'utf8')
}

/** Get or create the simulated owner for an agent. */
export function dryRunOwner(agentLabel: string): PrivateKey {
  const owners = read()
  const existing = owners[agentLabel]
  if (existing !== undefined) return PrivateKey.fromHex(existing)

  const key = PrivateKey.fromRandom()
  owners[agentLabel] = key.toHex()
  write(owners)
  return key
}

/** An attestation from the simulated owner, for passing inline. */
export async function dryRunAttestation(
  agentLabel: string,
  agentPubKey: string
): Promise<AgentAttestation> {
  return await signAgentAttestation(new ProtoWallet(dryRunOwner(agentLabel)), agentPubKey)
}

export const hasDryRunOwner = (agentLabel: string): boolean => read()[agentLabel] !== undefined
