/**
 * Who vouches for Lisa's agent.
 *
 * The real owner is her BSV Desktop identity, which signs in the browser and
 * stores the attestation on the server. In dry-run, until that exists, a
 * simulated owner stands in (same rule as `npm run test-pay`). In live mode
 * there is no fallback: an unvouched contribution should be rejected.
 */
import type { AgentAttestation } from '@upstream/shared/attestation'
import type { Runtime } from '@upstream/shared/runtime'
import { dryRunAttestation } from '../lib/dryRunOwners.ts'

export type OwnerSource = 'bsv-desktop' | 'simulated' | 'none'

export async function storedAttestation(
  runtime: Runtime,
  agentPubKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<AgentAttestation | undefined> {
  try {
    const res = await fetchImpl(`${runtime.serverUrl}/attestation`)
    if (!res.ok) return undefined
    const stored = (await res.json()) as AgentAttestation[]
    return stored.find(a => a.agentPubKey === agentPubKey)
  } catch {
    return undefined
  }
}

export async function resolveLisaOwner(
  runtime: Runtime,
  agent: { label: string; pubKey: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ attestation?: AgentAttestation; source: OwnerSource }> {
  const stored = await storedAttestation(runtime, agent.pubKey, fetchImpl)
  if (stored !== undefined) return { attestation: stored, source: 'bsv-desktop' }
  if (runtime.dryRun) {
    return { attestation: await dryRunAttestation(agent.label, agent.pubKey), source: 'simulated' }
  }
  return { source: 'none' }
}
