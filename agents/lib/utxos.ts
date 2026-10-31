/**
 * Each agent's current spendable output, persisted to `data/utxos/<agent>.json`.
 *
 * ONE FILE PER AGENT, deliberately. The earlier design kept every agent in a
 * single `data/utxos.json` and `putUtxo` rewrote the whole thing: read, modify,
 * write. Inside one process that is safe, but `swarm`, `whale`, `lisa` and
 * `sybil` are separate processes, so two writes could interleave and one would
 * silently undo the other. An agent would then still be holding an output it
 * had already spent — harmless in dry-run, a double spend Arcade rejects when
 * live. With a file per agent, concurrent processes touch disjoint paths and
 * cannot clobber each other.
 *
 * Writes are atomic: a temporary file in the same directory, then a rename.
 * A concurrent reader sees either the old record or the new one, never a
 * half-written file.
 *
 * An agent spends one output at a time and chains: the change of a contribution
 * becomes the input of the next, so a hundred contributions need one funding
 * output, not a hundred. Unconfirmed chaining is normal on BSV.
 *
 * A UTXO carries its source transaction hex, which is what lets the SDK sign
 * and script-verify without asking the network for anything.
 *
 * In dry-run the agents start from a synthetic funding transaction — fake coins,
 * real structure — so the whole flow runs end to end offline. Those records are
 * marked `synthetic: true` and are never mistaken for real money.
 */
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { Budget } from '@upstream/shared/budget'
import { DATA_DIR, type KeyRecord, type KeyStore } from '@upstream/shared/keystore'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

/** The per-agent directory. */
export const utxoDir = (): string => join(dataDir(), 'utxos')

/** Where every agent's record used to live, before the per-agent split. */
const legacyFile = (): string => join(dataDir(), 'utxos.json')

/**
 * Agent labels become file names, so refuse anything that is not a plain label.
 * Our own labels are like "swarm-agent-007"; this stops a crafted one escaping
 * the directory.
 */
function fileFor(agent: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) {
    throw new Error(`"${agent}" is not a usable agent label`)
  }
  return join(utxoDir(), `${agent}.json`)
}

/**
 * Write a record atomically.
 *
 * The temporary file sits in the same directory so the rename stays on one
 * filesystem and is therefore atomic. Node's rename replaces an existing
 * destination on Windows as well as POSIX.
 */
function writeAtomic(path: string, body: string): void {
  mkdirSync(utxoDir(), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, body, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Split a legacy `data/utxos.json` into per-agent files, once.
 *
 * Called before any read so an existing demo keeps its balances instead of
 * appearing to have lost them. The legacy file is renamed rather than deleted,
 * so nothing is destroyed if the migration is wrong.
 */
export function migrateLegacyUtxos(): { migrated: number } {
  const legacy = legacyFile()
  if (!existsSync(legacy)) return { migrated: 0 }

  let all: Record<string, AgentUtxo> = {}
  try {
    all = JSON.parse(readFileSync(legacy, 'utf8')) as Record<string, AgentUtxo>
  } catch {
    return { migrated: 0 }
  }

  let migrated = 0
  for (const [agent, utxo] of Object.entries(all)) {
    const path = fileFor(agent)
    // Never overwrite a per-agent record: it is the newer of the two.
    if (existsSync(path)) continue
    writeAtomic(path, `${JSON.stringify({ ...utxo, agent }, null, 2)}\n`)
    migrated++
  }

  renameSync(legacy, `${legacy}.migrated`)
  return { migrated }
}

/** One agent's current output, or undefined if it holds none. */
export function getUtxo(agent: string): AgentUtxo | undefined {
  migrateLegacyUtxos()
  const path = fileFor(agent)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentUtxo
  } catch {
    // A torn read cannot happen through the atomic write, but a hand-edited
    // file can still be broken; treat it as "no output" rather than crashing.
    return undefined
  }
}

/** Replace one agent's output. Touches only that agent's file. */
export function putUtxo(utxo: AgentUtxo): void {
  writeAtomic(fileFor(utxo.agent), `${JSON.stringify(utxo, null, 2)}\n`)
}

/** Remove an agent's output, e.g. once it is spent down to dust. */
export function dropUtxo(agent: string): void {
  rmSync(fileFor(agent), { force: true })
}

/**
 * Every agent's output, for the seeding summary and `demo:check`.
 *
 * A snapshot, not a transaction: another process may write while this reads,
 * so treat the result as "roughly now" and never write it back wholesale.
 */
export function readUtxos(): Record<string, AgentUtxo> {
  migrateLegacyUtxos()
  const dir = utxoDir()
  if (!existsSync(dir)) return {}

  const all: Record<string, AgentUtxo> = {}
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const agent = name.slice(0, -'.json'.length)
    const utxo = getUtxo(agent)
    if (utxo !== undefined) all[agent] = utxo
  }
  return all
}

/**
 * Replace every record. For tests and for a deliberate reset — never on the
 * contribution path, where it would reintroduce the clobbering this file
 * exists to prevent.
 */
export function writeUtxos(all: Record<string, AgentUtxo>): void {
  rmSync(utxoDir(), { recursive: true, force: true })
  mkdirSync(utxoDir(), { recursive: true })
  for (const [agent, utxo] of Object.entries(all)) putUtxo({ ...utxo, agent })
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
  migrateLegacyUtxos()
  let seeded = 0
  let skipped = 0

  for (const utxo of utxos) {
    if (getUtxo(utxo.agent) !== undefined) {
      skipped++
      continue
    }
    putUtxo(utxo)
    seeded++
  }

  return { seeded, skipped, txid: tx.id('hex') }
}

/** The agent's signing key, looked up by label. */
export function findAgentKey(keys: KeyStore, label: string): KeyRecord | undefined {
  return [keys.lisa, ...keys.swarm.map(s => s.agent), keys.whale.agent, ...keys.sybil].find(
    k => k.label === label
  )
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
