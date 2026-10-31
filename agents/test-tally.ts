/**
 * `npm run test-tally` — exercise the Phase 5 tally server end to end.
 *
 * IMPORTANT: the transactions this builds are NOT broadcast and are NOT
 * spendable. They are assembled offline with no funded input, purely so the
 * server has something real to parse: a P2PKH output paying a project, the
 * `UPSTREAM|<round>|<projectId>` OP_RETURN, and change. Phase 5 verifies
 * transaction STRUCTURE and owner signatures, which is exactly what this
 * covers. Phase 4 is what will produce real, broadcast contributions.
 *
 * Nothing here touches the wallet or spends a satoshi.
 *
 * It plays out the demo's argument in miniature:
 *   - a crowd of separate owners making small contributions
 *   - one whale making a large one
 *   - sybil agents with no owner signature, which the server refuses
 */
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'
import { signAgentAttestation } from '@upstream/shared/attestation'
import { contributionScript } from '@upstream/shared/opreturn'
import { loadBudget, sats } from '@upstream/shared/budget'
import { PROJECTS, findProject } from '@upstream/shared/projects'
import type { TallyRow } from '@upstream/shared'

const BASE = process.env.UPSTREAM_SERVER ?? `http://localhost:${process.env.PORT ?? 8787}`
const ROUND = process.env.ROUND ?? 'round-1'
const budget = loadBudget(process.env)

interface TallyResponse {
  pool: number
  rows: TallyRow[]
  totalRaised: number
  totalMatched: number
  contributions: number
  owners: number
  rejected: number
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : null
  if (!res.ok) {
    throw new Error((parsed as { error?: string } | null)?.error ?? `${path}: ${res.status}`)
  }
  return parsed as T
}

/**
 * A contribution-shaped transaction. Unbroadcast: no real input is attached,
 * so this can never move funds.
 */
function buildContribution(projectId: string, amount: number): Transaction {
  // An unknown project id is not an error here: that is precisely what a sybil
  // does — invent a project, pay an address of its own, and tag it anyway.
  const address = findProject(projectId)?.address ?? PrivateKey.fromRandom().toAddress([0x00])

  const tx = new Transaction()
  // output 0: pay the project
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: amount })
  // output 1: the tag that makes the round auditable from the chain alone
  tx.addOutput({
    lockingScript: Script.fromHex(contributionScript(ROUND, projectId)),
    satoshis: 0
  })
  // output 2: change back to the agent
  tx.addOutput({
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress([0x00])),
    satoshis: 1_000
  })
  return tx
}

/** Contribute as a fresh owner, or as an unvouched sybil. */
async function contribute(
  projectId: string,
  amount: number,
  opts: { vouched: boolean; owner?: ProtoWallet } = { vouched: true }
): Promise<{ ok: boolean; detail: string }> {
  try {
    const agentKey = PrivateKey.fromRandom().toPublicKey().toString()
    const tx = buildContribution(projectId, amount)

    let ownerPubKey = ''
    let ownerSignature = ''
    if (opts.vouched) {
      const owner = opts.owner ?? new ProtoWallet(PrivateKey.fromRandom())
      const att = await signAgentAttestation(owner, agentKey)
      ownerPubKey = att.ownerPubKey
      ownerSignature = att.signature
    }

    const stored = await api<{ sats: number; txid: string }>('/contribution', {
      rawTxHex: tx.toHex(),
      projectId,
      agentPubKey: agentKey,
      ownerPubKey,
      ownerSignature
    })
    return { ok: true, detail: `${stored.sats} sats · ${stored.txid.slice(0, 12)}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

/** Print tally events as the server emits them, to prove /events works. */
async function watchEvents(signal: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/events`, { signal, headers: { accept: 'text/event-stream' } })
  if (res.body === null) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let count = 0

  while (!signal.aborted) {
    let chunk: ReadableStreamReadResult<Uint8Array>
    try {
      chunk = await reader.read()
    } catch {
      break // aborted at the end of the run, which is the normal exit
    }
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const type = /event: (\w+)/.exec(frame)?.[1]
      if (type === undefined) continue
      count++
      if (type !== 'tally') console.log(`    [sse] ${type}`)
    }
  }
  console.log(`\n  /events delivered ${count} event(s).`)
}

const line = (): void => console.log('')

async function main(): Promise<void> {
  console.log(`Upstream tally smoke test → ${BASE} (round ${ROUND})`)
  console.log('Transactions are built offline and NEVER broadcast. No satoshis move.')
  line()

  const health = await api<{ round: string; network: string; phase: number }>('/health')
  if (health.round !== ROUND) {
    throw new Error(`server is running round "${health.round}", this script uses "${ROUND}"`)
  }
  console.log(`server: phase ${health.phase} · ${health.network} · round ${health.round}`)

  const controller = new AbortController()
  const events = watchEvents(controller.signal).catch((err: unknown) => {
    if (!controller.signal.aborted) {
      console.log(`  (could not read /events: ${(err as Error).message})`)
    }
  })

  line()
  console.log(`Sponsor pledges ${sats(budget.sponsorPoolSats)} sats.`)
  await api('/pledge', { pool: budget.sponsorPoolSats })

  // A crowd: many separate owners, small amounts. This is what QF rewards.
  line()
  console.log('Crowd: 8 separate owners → stream-utils, 6 → compress-lite')
  let ok = 0
  for (const [projectId, owners] of [
    ['stream-utils', 8],
    ['compress-lite', 6]
  ] as const) {
    for (let i = 0; i < owners; i++) {
      const r = await contribute(projectId, budget.contributionSats)
      if (r.ok) ok++
      else console.log(`  failed: ${r.detail}`)
    }
  }
  console.log(`  ${ok} contributions accepted.`)

  // One owner running several agents still counts once.
  line()
  console.log('One owner, 4 agents → log-helper (should count as ONE supporter)')
  const busyOwner = new ProtoWallet(PrivateKey.fromRandom())
  for (let i = 0; i < 4; i++) {
    await contribute('log-helper', budget.contributionSats, { vouched: true, owner: busyOwner })
  }

  // The whale: one owner, a large amount, no matching.
  line()
  console.log(`Whale: 1 owner → tiny-tls, ${sats(budget.whaleContributionSats)} sats`)
  const whale = await contribute('tiny-tls', budget.whaleContributionSats)
  console.log(`  ${whale.ok ? 'accepted' : 'FAILED'}: ${whale.detail}`)

  // The sybil attack: agents with no owner signature at all.
  line()
  console.log(`Sybil: ${budget.sybilSize} unvouched agents → color-text (all should be refused)`)
  let refused = 0
  for (let i = 0; i < budget.sybilSize; i++) {
    const r = await contribute('color-text', budget.contributionSats, { vouched: false })
    if (!r.ok) refused++
    else console.log('  WARNING: an unvouched agent was accepted')
  }
  console.log(`  ${refused}/${budget.sybilSize} refused.`)

  // A sybil claiming a project that does not exist, as Phase 7 will.
  const fake = await contribute('totally-legit', budget.contributionSats, { vouched: false })
  console.log(`  fake project refused: ${!fake.ok} (${fake.detail})`)

  line()
  const t = await api<TallyResponse>('/tally')
  console.log(`Tally — pool ${sats(t.pool)} sats`)
  console.log(
    `  ${t.contributions} contributions · ${t.owners} owners · ${sats(t.totalRaised)} raised · ${sats(t.totalMatched)} matched · ${t.rejected} rejected`
  )
  line()
  console.log('  project          supporters    raised     match')
  for (const row of t.rows) {
    const name = row.project.padEnd(16)
    console.log(
      `  ${name} ${String(row.supporters).padStart(10)} ${sats(row.raised).padStart(9)} ${sats(row.match).padStart(9)}`
    )
  }
  for (const p of PROJECTS) {
    if (!t.rows.some(r => r.project === p.id)) {
      console.log(`  ${p.id.padEnd(16)} ${'—'.padStart(10)} ${'—'.padStart(9)} ${'—'.padStart(9)}`)
    }
  }

  line()
  const whaleRow = t.rows.find(r => r.project === 'tiny-tls')
  const crowdRow = t.rows.find(r => r.project === 'stream-utils')
  const soloRow = t.rows.find(r => r.project === 'log-helper')
  console.log('What to check:')
  console.log(`  whale raised the most and matched ${sats(whaleRow?.match ?? 0)}  (expected 0)`)
  console.log(`  crowd matched ${sats(crowdRow?.match ?? 0)} from ${crowdRow?.supporters ?? 0} supporters`)
  console.log(`  one owner with 4 agents counted as ${soloRow?.supporters ?? 0} supporter(s)  (expected 1)`)
  console.log(`  color-text has no row at all — every sybil was refused`)

  controller.abort()
  await events
}

main().catch(err => {
  console.error(`\n${(err as Error).message}`)
  console.error('Is the server running? npm run server')
  process.exit(1)
})
