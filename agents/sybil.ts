/**
 * `npm run sybil` — the attack: SYBIL_SIZE agents with NO owner signature
 * contribute to a project that does not exist, `totally-legit`.
 *
 * Every one must be rejected by the tally server (which emits a `rejected`
 * event for each). The script exits non-zero if any is accepted.
 *
 * The transactions are real and signed: the fake project has no address, so
 * each sybil pays itself and tags the output anyway. With DRY_RUN=false they
 * are broadcast and cost the attacker a fee each — and still count for nothing.
 */
import { PrivateKey } from '@bsv/sdk'
import { loadBudget, sats } from '@upstream/shared/budget'
import { loadKeys } from '@upstream/shared/keystore'
import { describeMode, loadRuntime } from '@upstream/shared/runtime'
import { contribute, short } from './lib/contribute.ts'
import { fetchTally, requireServer } from './lib/swarm/server.ts'
import { getUtxo } from './lib/utxos.ts'

const runtime = loadRuntime(process.env)
const budget = loadBudget(process.env)
const FAKE_PROJECT = 'totally-legit'

async function main(): Promise<void> {
  console.log(describeMode(runtime))
  console.log('')
  await requireServer(runtime)

  const before = await fetchTally(runtime)
  const sybils = loadKeys().sybil.slice(0, budget.sybilSize)
  const funded = sybils.filter(s => getUtxo(s.label) !== undefined)
  if (funded.length === 0) {
    console.error('No sybil agent holds a spendable output.')
    console.error(runtime.dryRun ? '  npm run seed-agents' : '  fund the agents in the web app first')
    process.exitCode = 1
    return
  }

  console.log(`Sybil attack: ${funded.length} unvouched agents → "${FAKE_PROJECT}", ${sats(budget.contributionSats)} sats each`)
  console.log('')

  const results = await Promise.all(
    funded.map(async s => {
      try {
        // No owner, no attestation: that is what makes it a sybil.
        const r = await contribute(
          { agentLabel: s.label, agentKey: PrivateKey.fromHex(s.privHex), projectId: FAKE_PROJECT },
          { budget, runtime }
        )
        return { label: s.label, txid: r.txid, accepted: r.accepted, message: r.serverMessage }
      } catch (err) {
        return { label: s.label, txid: '', accepted: false, message: `not sent: ${(err as Error).message}` }
      }
    })
  )

  for (const r of results) {
    console.log(
      `  ${r.label} ${r.txid !== '' ? short(r.txid) : '—'.padEnd(12)} ${r.accepted ? 'ACCEPTED (!)' : 'rejected'}: ${r.message}`
    )
  }

  const sent = results.filter(r => r.txid !== '')
  const accepted = results.filter(r => r.accepted)
  const unreachable = sent.filter(r => r.message.startsWith('could not reach'))
  console.log('')
  console.log(`${sent.length - accepted.length - unreachable.length}/${sent.length} rejected by the tally server.`)

  const after = await fetchTally(runtime)
  if (before !== null && after !== null) {
    console.log(
      `Server rejected count ${before.rejected} → ${after.rejected}; ` +
        `matched supporters unchanged at ${before.owners} → ${after.owners}.`
    )
    if (after.rows.some(r => r.project === FAKE_PROJECT)) {
      console.log(`WARNING: "${FAKE_PROJECT}" appears in the tally.`)
      process.exitCode = 1
    }
  }

  if (accepted.length > 0) {
    console.log('FAIL: an unvouched agent was accepted.')
    process.exitCode = 1
  } else if (unreachable.length > 0 || sent.length === 0) {
    console.log('Could not confirm the rejection with the server.')
    process.exitCode = 1
  } else {
    console.log('Attack defeated: no owner signature, no matching weight.')
  }
}

main().catch((err: unknown) => {
  console.error(`\n${(err as Error).message}`)
  process.exitCode = 1
})
