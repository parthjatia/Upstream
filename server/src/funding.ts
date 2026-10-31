/**
 * The funding plan and the record of what the wallet actually broadcast.
 *
 * The server is the only side that can read `keys/`, so it builds the plan the
 * browser spends to. It returns addresses and amounts — never private keys.
 */
import { P2PKH, Transaction } from '@bsv/sdk'
import { loadBudget, type Budget } from '@upstream/shared/budget'
import { loadKeys, type KeyRecord, type KeyStore } from '@upstream/shared/keystore'
import {
  summarize,
  type FundedOutput,
  type FundingRecord,
  type FundingScope,
  type FundingSummary,
  type FundingTarget
} from '@upstream/shared/funding'
import { dataPath, readJson, repoRelative, writeJson, writeText } from './store.ts'

const RECORDS = (): string => dataPath('funding.json')

/** Every agent address to fund, with the amount from the budget. */
export function fundingTargets(keys: KeyStore, budget: Budget, scope: FundingScope): FundingTarget[] {
  const lisa: FundingTarget = {
    label: keys.lisa.label,
    kind: 'lisa',
    address: keys.lisa.address,
    satoshis: budget.fundLisaSats
  }
  if (scope === 'lisa') return [lisa]

  const of = (r: KeyRecord, kind: FundingTarget['kind'], satoshis: number): FundingTarget => ({
    label: r.label,
    kind,
    address: r.address,
    satoshis
  })

  return [
    lisa,
    ...keys.swarm.map(s => of(s.agent, 'swarm', budget.fundSwarmAgentSats)),
    of(keys.whale.agent, 'whale', budget.fundWhaleSats),
    ...keys.sybil.map(s => of(s, 'sybil', budget.fundSybilAgentSats))
  ]
}

export const totalSats = (targets: FundingTarget[]): number =>
  targets.reduce((a, t) => a + t.satoshis, 0)

/**
 * Resolve which output index funded which agent, by matching locking scripts.
 * Never assumes index 0 or the order given: the wallet appends change, and an
 * index is only trustworthy when the script proves it.
 */
export function resolveOutputs(tx: Transaction, targets: FundingTarget[]): FundedOutput[] {
  const scripts = tx.outputs.map(o => o.lockingScript.toHex())
  const taken = new Set<number>()
  const resolved: FundedOutput[] = []

  for (const t of targets) {
    const want = new P2PKH().lock(t.address).toHex()
    const index = scripts.findIndex((s, i) => s === want && !taken.has(i))
    if (index < 0) {
      throw new Error(`funding transaction has no output paying ${t.label} (${t.address})`)
    }
    taken.add(index)

    const got = tx.outputs[index]?.satoshis
    if (got !== t.satoshis) {
      throw new Error(
        `output ${index} pays ${t.label} ${got} sats, expected ${t.satoshis}`
      )
    }
    resolved.push({ index, label: t.label, kind: t.kind, address: t.address, satoshis: t.satoshis })
  }
  return resolved
}

export const allRecords = (): FundingRecord[] => readJson<FundingRecord[]>(RECORDS(), [])

export const fundingSummaries = (): FundingSummary[] => allRecords().map(summarize)

/**
 * Record a broadcast funding transaction: save the AtomicBEEF and the
 * index -> agent map. Idempotent on txid, so a retried POST cannot double-record.
 */
export function recordFunding(args: {
  scope: FundingScope
  round: string
  txid: string
  beefHex: string
  tx: Transaction
  targets: FundingTarget[]
}): FundingRecord {
  const { scope, round, txid, beefHex, tx, targets } = args

  const existing = allRecords().find(r => r.txid === txid)
  if (existing) return existing

  const outputs = resolveOutputs(tx, targets)
  const beefFile = dataPath(`funding-${scope}-${txid}.beef`)
  writeText(beefFile, beefHex)

  const record: FundingRecord = {
    scope,
    txid,
    round,
    createdAt: new Date().toISOString(),
    totalSats: outputs.reduce((a, o) => a + o.satoshis, 0),
    outputs,
    beefPath: repoRelative(beefFile)
  }

  writeJson(RECORDS(), [...allRecords(), record])
  return record
}

/** Load keys and budget together, with a clear error when keys are missing. */
export function fundingContext(env: NodeJS.ProcessEnv): { keys: KeyStore; budget: Budget } {
  return { keys: loadKeys(), budget: loadBudget(env) }
}
