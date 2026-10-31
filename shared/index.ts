/**
 * Shared surface for server, agents and web.
 *
 * Phase 1 defines only the contracts the other phases fill in:
 *  - Phase 2 adds quadraticMatch() and the generated project registry
 *  - Phase 4 adds the OP_RETURN helpers
 */

/** Identifier of the current funding round, e.g. "round-1". */
export const DEFAULT_ROUND = 'round-1'

/** Prefix of the OP_RETURN tag on every contribution: `UPSTREAM|<round>|<projectId>`. */
export const OP_RETURN_PREFIX = 'UPSTREAM'

/** A sponsored open-source project. Addresses are testnet; keys live in `keys/`. */
export interface Project {
  id: string
  name: string
  address: string
  /** The real-world security incident this demo project is modelled on. */
  story: string
}

/** One verified contribution: an agent paid a project on behalf of its owner. */
export interface Contribution {
  project: string
  /** Owner identity public key — matching counts owners, not agents. */
  owner: string
  sats: number
}

/** What an agent reports to the server after broadcasting a contribution. */
export interface ContributionReport {
  rawTxHex: string
  projectId: string
  agentPubKey: string
  ownerPubKey: string
  ownerSignature: string
}

/** One row of the quadratic-funding tally. */
export interface TallyRow {
  project: string
  raised: number
  supporters: number
  gap: number
  match: number
}

/** Events pushed to the web UI over SSE at `GET /events`. */
export type UpstreamEvent =
  | { type: 'contribution'; project: string; owner: string; sats: number; txid: string }
  | { type: 'rejected'; project: string; reason: string; txid?: string }
  | { type: 'tally'; pool: number; rows: TallyRow[] }
  | { type: 'settled'; txid: string; rows: TallyRow[] }
