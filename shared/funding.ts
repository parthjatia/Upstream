/**
 * Phase 3 funding: the types the browser and the server exchange.
 *
 * The browser cannot read `keys/`, so the server owns the funding plan and
 * hands over addresses and amounts only. The browser builds ONE `createAction`
 * from that plan, BSV Desktop signs and broadcasts it, and the browser posts
 * the AtomicBEEF back so the server can record which output index funded which
 * agent. No private key is ever sent, asked for, or held outside the wallet.
 */

/** Which family an agent belongs to. */
export type AgentKind = 'lisa' | 'swarm' | 'whale' | 'sybil'

/** `lisa` funds Lisa's agent alone (the smoke test); `all` is the full fan-out. */
export type FundingScope = 'lisa' | 'all'

/** One output the browser should create. */
export interface FundingTarget {
  /** Key label, e.g. "swarm-agent-007". */
  label: string
  kind: AgentKind
  /** Mainnet P2PKH address. */
  address: string
  satoshis: number
}

/** What `GET /funding-plan` returns. */
export interface FundingPlanResponse {
  scope: FundingScope
  round: string
  network: string
  targets: FundingTarget[]
  totalSats: number
  /** Rounds already funded, so the UI can warn before spending twice. */
  alreadyFunded: FundingSummary[]
}

/** What the browser posts to `POST /funding` after the wallet broadcasts. */
export interface FundingReport {
  scope: FundingScope
  txid: string
  /** AtomicBEEF (BRC-95) as hex, from `createAction`'s `tx`. */
  beefHex: string
}

/** One funded agent, resolved to its output index in the funding transaction. */
export interface FundedOutput {
  /** Index in the transaction. Found by locking script, never assumed. */
  index: number
  label: string
  kind: AgentKind
  address: string
  satoshis: number
}

/** The record the server keeps per funding transaction. */
export interface FundingRecord {
  scope: FundingScope
  txid: string
  round: string
  createdAt: string
  totalSats: number
  outputs: FundedOutput[]
  /** Path of the saved BEEF, relative to the repo root. */
  beefPath: string
}

/** The short form returned in listings. */
export interface FundingSummary {
  scope: FundingScope
  txid: string
  createdAt: string
  totalSats: number
  agents: number
}

export const summarize = (r: FundingRecord): FundingSummary => ({
  scope: r.scope,
  txid: r.txid,
  createdAt: r.createdAt,
  totalSats: r.totalSats,
  agents: r.outputs.length
})

/** Explorer link for a transaction. Mainnet. */
export const explorerTxUrl = (txid: string, base = 'https://whatsonchain.com/tx/'): string =>
  `${base}${txid}`
