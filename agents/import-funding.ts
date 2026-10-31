/**
 * `npm run import-funding <txid>` — adopt a real funding transaction.
 *
 * The backup path for funding the agents: if the satoshis are sent by a manual
 * Send from BSV Desktop rather than the app's button, this fetches that
 * transaction, finds every output paying one of our agent addresses, and
 * records them as real spendable outputs.
 *
 * Reads the chain only. Nothing is signed, nothing is spent, and the private
 * keys are used for nothing but deriving the addresses to look for.
 *
 * WhatsOnChain rate-limits (the guide notes 429s on the free API), but this is
 * one request per run, so it is the right tool here.
 */
import { P2PKH, Transaction } from '@bsv/sdk'
import { sats } from '@upstream/shared/budget'
import { loadRuntime } from '@upstream/shared/runtime'
import { loadKeys, type KeyRecord } from '@upstream/shared/keystore'
import { putUtxo, readUtxos, type AgentUtxo } from './lib/utxos.ts'

const runtime = loadRuntime(process.env)

const txid = process.argv[2]?.trim().toLowerCase()
if (txid === undefined || !/^[0-9a-f]{64}$/.test(txid)) {
  console.error('Usage: npm run import-funding <txid>')
  console.error('')
  console.error('  <txid> is the 64-hex id of the transaction that funded the agents.')
  process.exit(1)
}

const WOC_NETWORK = runtime.network === 'mainnet' ? 'main' : 'test'
const WOC = `https://api.whatsonchain.com/v1/bsv/${WOC_NETWORK}/tx/${txid}/hex`

async function fetchRawTx(): Promise<string> {
  const res = await fetch(WOC)
  if (res.status === 404) {
    throw new Error(
      `WhatsOnChain does not know ${txid} on ${WOC_NETWORK}net. ` +
        'Check the txid, and that it has been broadcast.'
    )
  }
  if (res.status === 429) {
    throw new Error('WhatsOnChain rate-limited the request (429). Wait a moment and retry.')
  }
  if (!res.ok) {
    throw new Error(`WhatsOnChain returned ${res.status} for ${txid}`)
  }
  const hex = (await res.text()).trim()
  if (!/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`WhatsOnChain returned something that is not raw hex: ${hex.slice(0, 80)}`)
  }
  return hex
}

async function main(): Promise<void> {
  console.log(`Importing funding transaction ${txid}`)
  console.log(`  from ${WOC}`)
  console.log('')

  const rawTxHex = await fetchRawTx()
  const tx = Transaction.fromHex(rawTxHex)

  // Never trust the id we were given over the bytes we received.
  const actual = tx.id('hex')
  if (actual !== txid) {
    throw new Error(`the fetched transaction is ${actual}, not ${txid}`)
  }

  const keys = loadKeys()
  const agents: KeyRecord[] = [
    keys.lisa,
    ...keys.swarm.map(s => s.agent),
    keys.whale.agent,
    ...keys.sybil
  ]

  // Index agents by locking script, so outputs are matched by script and never
  // by position.
  const byScript = new Map<string, KeyRecord>()
  for (const agent of agents) {
    byScript.set(new P2PKH().lock(agent.address).toHex(), agent)
  }

  const existing = readUtxos()
  const found: AgentUtxo[] = []
  const replaced: string[] = []
  const now = new Date().toISOString()

  for (const [vout, output] of tx.outputs.entries()) {
    const script = output.lockingScript.toHex()
    const agent = byScript.get(script)
    if (agent === undefined) continue

    const utxo: AgentUtxo = {
      agent: agent.label,
      txid: actual,
      vout,
      satoshis: output.satoshis ?? 0,
      lockingScriptHex: script,
      sourceTxHex: rawTxHex,
      synthetic: false,
      origin: 'funding-import',
      updatedAt: now
    }
    found.push(utxo)

    const prior = existing[agent.label]
    if (prior !== undefined && !prior.synthetic && prior.txid !== actual) {
      replaced.push(`${agent.label} (was ${prior.txid.slice(0, 12)}, ${sats(prior.satoshis)} sats)`)
    }
  }

  if (found.length === 0) {
    console.error(`No output of ${actual} pays any of our ${agents.length} agent addresses.`)
    console.error('')
    console.error('Either this is not the funding transaction, or the keys have been')
    console.error('regenerated since it was sent (shared/projects.json would have changed too).')
    process.exitCode = 1
    return
  }

  // A real output always wins over a synthetic one: dry-run coins are a
  // placeholder and should give way the moment real money shows up.
  for (const utxo of found) putUtxo(utxo)

  const total = found.reduce((a, u) => a + u.satoshis, 0)
  const byKind = new Map<string, number>()
  for (const u of found) {
    const kind = u.agent.replace(/-\d+$/, '')
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1)
  }

  console.log(`Imported ${found.length} output(s) totalling ${sats(total)} sats:`)
  for (const [kind, count] of byKind) {
    console.log(`  ${String(count).padStart(3)} × ${kind}`)
  }
  console.log('')
  console.log('  output  agent                 sats')
  for (const u of found.slice(0, 10)) {
    console.log(`  #${String(u.vout).padEnd(5)} ${u.agent.padEnd(20)} ${sats(u.satoshis).padStart(8)}`)
  }
  if (found.length > 10) console.log(`  … and ${found.length - 10} more`)

  if (replaced.length > 0) {
    console.log('')
    console.log(`Replaced ${replaced.length} earlier real output(s):`)
    for (const r of replaced.slice(0, 5)) console.log(`  ${r}`)
    console.log('  Those satoshis are not lost, but the agents will no longer spend them.')
  }

  const missing = agents.filter(a => !found.some(u => u.agent === a.label))
  if (missing.length > 0) {
    console.log('')
    console.log(`${missing.length} agent(s) were not paid by this transaction:`)
    console.log(`  ${missing.slice(0, 6).map(a => a.label).join(', ')}${missing.length > 6 ? ', …' : ''}`)
    console.log('  Import the transaction that funded them, or seed them in dry-run.')
  }

  console.log('')
  console.log(`${runtime.explorerTxUrl}${actual}`)
  console.log('Next: npm run test-pay')
}

// process.exit() while an HTTP socket is still open aborts libuv on Windows,
// so set the code and let the event loop drain.
main().catch((err: unknown) => {
  console.error('')
  console.error((err as Error).message)
  process.exitCode = 1
})
