/**
 * `npm run demo:check` — a read-only status board before (or during) a demo.
 *
 * Prints:
 *   1. live vs dry-run, from this .env;
 *   2. which agents hold REAL coins and which hold SYNTHETIC dry-run coins
 *      (from data/utxos.json);
 *   3. whether the tally server is up, and what it is counting;
 *   4. whether BSV Desktop answers, and on which network.
 *
 * It never spends, signs or broadcasts anything, and never prints a key. The
 * wallet probe only calls getVersion / isAuthenticated / getNetwork, which need
 * no permission prompt.
 */
import { WalletClient } from '@bsv/sdk'
import { loadBudget, sats } from '@upstream/shared/budget'
import { describeMode, loadRuntime } from '@upstream/shared/runtime'
import { loadKeys, type KeyStore } from '@upstream/shared/keystore'
import { readUtxos, type AgentUtxo } from '../agents/lib/utxos.ts'

const runtime = loadRuntime(process.env)
const budget = loadBudget(process.env)
const ORIGINATOR = process.env.DEMO_CHECK_ORIGINATOR ?? 'localhost'
const TIMEOUT_MS = 6_000

const issues: string[] = []
const ok = (s: string) => `  ✔ ${s}`
const no = (s: string) => `  ✘ ${s}`
const note = (s: string) => `  · ${s}`

function heading(s: string): void {
  console.log('')
  console.log(s)
}

async function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        handle = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(handle)
  }
}

/* -------------------------------------------------------------- 1. mode */

heading('Mode')
console.log(`  ${describeMode(runtime)}`)
console.log(note(`round ${runtime.round} · network ${runtime.network} · server ${runtime.serverUrl}`))
console.log(note(`Arcade ${runtime.arcadeUrl}`))

/* ------------------------------------------------------------ 2. agents */

type Kind = 'lisa' | 'swarm' | 'whale' | 'sybil'

function agentKinds(keys: KeyStore): Map<string, Kind> {
  const m = new Map<string, Kind>()
  m.set(keys.lisa.label, 'lisa')
  for (const s of keys.swarm) m.set(s.agent.label, 'swarm')
  m.set(keys.whale.agent.label, 'whale')
  for (const s of keys.sybil) m.set(s.label, 'sybil')
  return m
}

heading('Agents (data/utxos.json)')
let keys: KeyStore | null = null
try {
  keys = loadKeys()
} catch (err) {
  console.log(no(`no keys: ${(err as Error).message}`))
  issues.push('run `npm run keys`')
}

const utxos = readUtxos()
if (keys !== null) {
  const kinds = agentKinds(keys)
  const rows: Record<Kind, { total: number; real: AgentUtxo[]; synthetic: AgentUtxo[] }> = {
    lisa: { total: 0, real: [], synthetic: [] },
    swarm: { total: 0, real: [], synthetic: [] },
    whale: { total: 0, real: [], synthetic: [] },
    sybil: { total: 0, real: [], synthetic: [] }
  }
  for (const [label, kind] of kinds) {
    rows[kind].total++
    const u = utxos[label]
    if (u === undefined) continue
    ;(u.synthetic ? rows[kind].synthetic : rows[kind].real).push(u)
  }

  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  console.log(`  ${pad('kind', 7)}${pad('agents', 8)}${pad('real', 18)}${pad('synthetic', 18)}none`)
  for (const kind of ['lisa', 'swarm', 'whale', 'sybil'] as const) {
    const r = rows[kind]
    const sum = (xs: AgentUtxo[]) => xs.reduce((a, u) => a + u.satoshis, 0)
    const none = r.total - r.real.length - r.synthetic.length
    console.log(
      `  ${pad(kind, 7)}${pad(r.total, 8)}` +
        `${pad(`${r.real.length} (${sats(sum(r.real))} sats)`, 18)}` +
        `${pad(`${r.synthetic.length} (${sats(sum(r.synthetic))} sats)`, 18)}${none}`
    )
  }

  const all = Object.values(rows)
  const realCount = all.reduce((a, r) => a + r.real.length, 0)
  const synthCount = all.reduce((a, r) => a + r.synthetic.length, 0)
  const holders = (k: Kind, which: 'real' | 'synthetic') =>
    rows[k][which].map(u => u.agent)

  // Name the individual agents when the list is short enough to read.
  for (const which of ['real', 'synthetic'] as const) {
    const names = (['lisa', 'whale', 'swarm', 'sybil'] as const).flatMap(k => holders(k, which))
    if (names.length > 0 && names.length <= 12) console.log(note(`${which}: ${names.join(', ')}`))
  }

  const unknown = Object.keys(utxos).filter(l => !kinds.has(l))
  if (unknown.length > 0) console.log(note(`${unknown.length} UTXO record(s) for unknown agents`))

  if (!runtime.dryRun && synthCount > 0) {
    console.log(no(`LIVE mode, but ${synthCount} agent(s) hold synthetic coins — their broadcasts will fail`))
    issues.push('live mode with synthetic coins: import the real funding (npm run import-funding <txid>)')
  }
  if (!runtime.dryRun && realCount === 0) {
    console.log(no('LIVE mode, but no agent holds a real coin'))
    issues.push('live mode with no funded agents')
  }
  if (runtime.dryRun && realCount + synthCount === 0) {
    console.log(no('no agent holds any coin'))
    issues.push('run `npm run seed-agents` (dry run) or fund the agents')
  }
  if (runtime.dryRun && realCount > 0) {
    console.log(note(`${realCount} agent(s) hold REAL coins; dry run will not broadcast them`))
  }
} else if (Object.keys(utxos).length > 0) {
  console.log(note(`${Object.keys(utxos).length} UTXO record(s), but no keys to classify them`))
}

/* ------------------------------------------------------------ 3. server */

heading(`Tally server (${runtime.serverUrl})`)

async function getJson<T>(path: string): Promise<T> {
  const res = await withTimeout(fetch(`${runtime.serverUrl}${path}`))
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

interface Health {
  round: string
  network: string
  phase: number
  pool: number
  contributions: number
  rejected: number
  listeners: number
}
interface TallyLite {
  owners: number
  totalRaised: number
  totalMatched: number
  contributions: number
  dryRunContributions: number
  rows: Array<{ project: string; match: number }>
}
interface PreviewLite {
  settleable: boolean
  reason: string | null
  totalSats: number
  serverDryRun: boolean
  resultsHash: string
  settled: { txid: string } | null
}

try {
  const h = await getJson<Health>('/health')
  console.log(ok(`up · round ${h.round} · ${h.network} · ${h.listeners} UI listener(s)`))
  if (h.round !== runtime.round) {
    console.log(no(`server round ${h.round} ≠ .env ROUND ${runtime.round}`))
    issues.push('server and .env disagree on ROUND')
  }
  if (h.network !== runtime.network) {
    console.log(no(`server network ${h.network} ≠ .env ${runtime.network}`))
    issues.push('server and .env disagree on network')
  }
  console.log(
    note(`pool ${sats(h.pool)} sats (budget ${sats(budget.sponsorPoolSats)}) · ${h.contributions} contribution(s) · ${h.rejected} rejected`)
  )

  const t = await getJson<TallyLite>('/tally')
  console.log(
    note(
      `tally: ${t.owners} owner(s), raised ${sats(t.totalRaised)} sats, matched ${sats(t.totalMatched)} sats` +
        (t.dryRunContributions > 0 ? ` · ${t.dryRunContributions} dry-run contribution(s)` : '')
    )
  )
  for (const r of t.rows.filter(x => x.match > 0)) console.log(note(`  ${r.project}: match ${sats(r.match)}`))

  try {
    const p = await getJson<PreviewLite>('/settlement/preview')
    if (p.settled !== null) console.log(ok(`settled in ${runtime.explorerTxUrl}${p.settled.txid}`))
    else if (p.settleable) console.log(ok(`settlement ready: ${sats(p.totalSats)} sats · hash ${p.resultsHash.slice(0, 16)}…`))
    else console.log(note(`settlement not ready: ${p.reason ?? 'unknown'}`))
    if (p.serverDryRun !== runtime.dryRun) {
      console.log(no(`server DRY_RUN=${p.serverDryRun}, this .env DRY_RUN=${runtime.dryRun}`))
      issues.push('server and .env disagree on DRY_RUN (restart the server)')
    }
  } catch (err) {
    console.log(no(`/settlement/preview: ${(err as Error).message}`))
  }
} catch (err) {
  console.log(no(`unreachable: ${(err as Error).message}`))
  issues.push('start the server: npm run server')
}

/* ------------------------------------------------------------ 4. wallet */

heading(`BSV Desktop (originator ${ORIGINATOR})`)
try {
  const wallet = new WalletClient('auto', ORIGINATOR)
  const { version } = await withTimeout(wallet.getVersion({}))
  console.log(ok(`reachable · ${version}`))
  try {
    const { authenticated } = await withTimeout(wallet.isAuthenticated({}))
    console.log(authenticated ? ok('unlocked') : no('locked — unlock BSV Desktop'))
    if (!authenticated) issues.push('unlock BSV Desktop')
    const { network } = await withTimeout(wallet.getNetwork({}))
    const same = network === runtime.network
    console.log(same ? ok(`on ${network}`) : no(`on ${network}, the demo runs ${runtime.network}`))
    if (!same) issues.push(`switch BSV Desktop to ${runtime.network}`)
  } catch (err) {
    console.log(no(`answered, then failed: ${(err as Error).message}`))
    issues.push('BSV Desktop answers but refuses calls')
  }
} catch (err) {
  console.log(no(`not reachable: ${(err as Error).message}`))
  issues.push('open BSV Desktop (needed for funding and settlement)')
}

/* ----------------------------------------------------------- summary */

heading('Summary')
if (issues.length === 0) {
  console.log(ok(`ready (${runtime.dryRun ? 'dry run' : 'LIVE'})`))
} else {
  for (const i of issues) console.log(no(i))
}
console.log('')
