/** Calls to the Upstream server. The browser never sees a private key. */
import type {
  FundingPlanResponse,
  FundingRecord,
  FundingScope
} from '@upstream/shared/funding'
import type { AgentAttestation } from '@upstream/shared/attestation'

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8787'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined
  })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${res.status}`
    throw new Error(msg)
  }
  return body as T
}

export interface Health {
  service: string
  round: string
  network: string
  phase: number
}

export interface LisaAgent {
  label: string
  agentPubKey: string
  address: string
  attested: { ownerPubKey: string; verified: boolean } | null
}

export interface StoredAttestation extends AgentAttestation {
  label: string
  verified: true
}

export const getHealth = (): Promise<Health> => call<Health>('/health')

export const getFundingPlan = (scope: FundingScope): Promise<FundingPlanResponse> =>
  call<FundingPlanResponse>(`/funding-plan?scope=${scope}`)

export const getLisaAgent = (): Promise<LisaAgent> => call<LisaAgent>('/agent/lisa')

export const postFunding = (body: {
  scope: FundingScope
  txid: string
  beefHex: string
}): Promise<FundingRecord> =>
  call<FundingRecord>('/funding', { method: 'POST', body: JSON.stringify(body) })

export const postAttestation = (att: AgentAttestation): Promise<StoredAttestation> =>
  call<StoredAttestation>('/attestation', { method: 'POST', body: JSON.stringify(att) })
