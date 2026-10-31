/**
 * Each agent's current spendable output, persisted to `data/utxos.json`.
 *
 * An agent spends one output at a time and chains: the change of a contribution
 * becomes the input of the next, so a hundred contributions need one funding
 * output, not a hundred. Unconfirmed chaining is normal on BSV.
 *
 * A UTXO carries its source transaction hex when we have it, which is what lets
 * the SDK sign and script-verify without asking the network for anything.
 *
 * In dry-run the agents start from a synthetic funding transaction — fake coins,
 * real structure — so the whole flow runs end to end offline. Those records are
 * marked `synthetic: true` and are never mistaken for real money.
 */
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { Budget } from '@upstream/shared/budget'
import { DATA_DIR, type KeyRecord, type KeyStore } from '@upstream/shared/keystore'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One spendable output belonging to one agent. */
export interface AgentUtxo {
  /** Key label, e.g. "swarm-agent-007". */
  agent: string
  txid: string
  vout: number
  satoshis: number
  lockingScriptHex: string
  /** Raw source transaction, so signing and verification need no network. */
  sourceTxHex: string
  /** True for dry-run coins that exist nowhere but this file. */
  synthetic: boolean
  /** How this output came to us. */
  origin: 'synthetic' | 'funding-import' | 'change'
  updatedAt: string
}

const dataDir = (): string => process.env.UPSTREAM_DATA_DIR ?? DATA_DIR
const file = (): string => join(dataDir(), 'utxos.json')

export function readUtxos(): Record<string, AgentUtxo> {
  const path = file()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, AgentUtxo>
  } catch {
    return {}
  }
}

export function writeUtxos(all: Record<string, AgentUtxo>): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(file(), `${JSON.stringify(all, null, 2)}\n`, 'utf8')
}

export const getUtxo = (agent: string): AgentUtxo | undefined => readUtxos()[agent]

export function putUtxo(utxo: AgentUtxo): void {
  const all = readUtxos()
  all[utxo.agent] = utxo
  writeUtxos(all)
}

/** Remove an agent's output, e.g. once it is spent down to dust. */
export function dropUtxo(agent: string): void {
  const all = readUtxos()
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete all[agent]
  writeUtxos(all)
}

/** Rebuild the source transaction an output came from. */
export const sourceTransaction = (utxo: AgentUtxo): Transaction =>
  Transaction.fromHex(utxo.sourceTxHex)

/**
 * Build a synthetic funding transaction paying every agent its budget amount.
 *
 * Structurally a real transaction — right addresses, right amounts, correct
 * script encoding — but with no input, so it could never be broadcast. That is
 * deliberate: dry-run coins must be impossible to confuse with real ones.
 */
export function synthesizeFunding(
  keys: KeyStore,
  budget: Budget
): { tx: Transaction; utxos: AgentUtxo[] } {
  const targets: Array<{ key: KeyRecord; satoshis: number }> = [
    { key: keys.lisa, satoshis: budget.fundLisaSats },
    ...keys.swarm.map(s => ({ key: s.agent, satoshis: budget.fundSwarmAgentSats })),
    { key: keys.whale.agent, satoshis: budget.fundWhaleSats },
    ...keys.sybil.map(s => ({ key: s, satoshis: budget.fundSybilAgentSats }))
  ]

  const tx = new Transaction()
  for (const t of targets) {
    tx.addOutput({ lockingScript: new P2PKH().lock(t.key.address), satoshis: t.satoshis })
  }

  const txid = tx.id('hex')
  const sourceTxHex = tx.toHex()
  const now = new Date().toISOString()

  const utxos = targets.map((t, vout) => ({
    agent: t.key.label,
    txid,
    vout,
    satoshis: t.satoshis,
    lockingScriptHex: new P2PKH().lock(t.key.address).toHex(),
    sourceTxHex,
    synthetic: true,
    origin: 'synthetic' as const,
    updatedAt: now
  }))

  return { tx, utxos }
}

/**
 * Give every agent a dry-run starting output, if it has none.
 *
 * Existing records are left alone, so seeding never overwrites an imported real
 * output or an agent's chained change.
 */
export function seedSyntheticFunding(
  keys: KeyStore,
  budget: Budget
): { seeded: number; skipped: number; txid: string } {
  const { tx, utxos } = synthesizeFunding(keys, budget)
  const all = readUtxos()
  let seeded = 0
  let skipped = 0

  for (const utxo of utxos) {
    if (all[utxo.agent] !== undefined) {
      skipped++
      continue
    }
    all[utxo.agent] = utxo
    seeded++
  }

  writeUtxos(all)
  return { seeded, skipped, txid: tx.id('hex') }
}

/** The agent's signing key, looked up by label. */
export function findAgentKey(keys: KeyStore, label: string): KeyRecord | undefined {
  return [
    keys.lisa,
    ...keys.swarm.map(s => s.agent),
    keys.whale.agent,
    ...keys.sybil
  ].find(k => k.label === label)
}

/** Every agent key, with the owner that vouches for it where one exists. */
export function agentsWithOwners(
  keys: KeyStore
): Array<{ agent: KeyRecord; owner: PrivateKey | null }> {
  return [
    // Lisa's owner is BSV Desktop, so there is no local private key for it.
    { agent: keys.lisa, owner: null },
    ...keys.swarm.map(s => ({ agent: s.agent, owner: PrivateKey.fromHex(s.owner.privHex) })),
    { agent: keys.whale.agent, owner: PrivateKey.fromHex(keys.whale.owner.privHex) },
    // Sybils have no owner at all; that is the point.
    ...keys.sybil.map(s => ({ agent: s, owner: null }))
  ]
}
