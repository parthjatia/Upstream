/**
 * `npm run seed-agents` — give every agent dry-run starting coins.
 *
 * Builds one synthetic funding transaction paying each agent its budget amount
 * and records the outputs as spendable. The transaction is structurally real
 * but has no input, so it could never be broadcast: dry-run coins are
 * impossible to confuse with real ones, and every record is marked
 * `synthetic: true`.
 *
 * Refuses to run when DRY_RUN=false, so a live round can never be seeded with
 * money that does not exist.
 */
import { loadBudget, describeBudget, sats } from '@upstream/shared/budget'
import { loadRuntime, describeMode } from '@upstream/shared/runtime'
import { loadKeys } from '@upstream/shared/keystore'
import { readUtxos, seedSyntheticFunding } from './lib/utxos.ts'

const runtime = loadRuntime(process.env)
const budget = loadBudget(process.env)

console.log(describeMode(runtime))
console.log('')

if (!runtime.dryRun) {
  console.error('Refusing to seed synthetic coins while DRY_RUN=false.')
  console.error('')
  console.error('In live mode the agents are funded by a real transaction:')
  console.error('  - the "Fund all agents" button in the web app, or')
  console.error('  - npm run import-funding <txid> after a manual Send.')
  process.exit(1)
}

const keys = loadKeys()
const { seeded, skipped, txid } = seedSyntheticFunding(keys, budget)
const all = readUtxos()
const total = Object.values(all).reduce((a, u) => a + u.satoshis, 0)
const real = Object.values(all).filter(u => !u.synthetic).length

console.log(`Synthetic funding transaction ${txid}`)
console.log(`  (never broadcast, and unbroadcastable: it has no input)`)
console.log('')
console.log(`  ${seeded} agent(s) seeded`)
if (skipped > 0) {
  console.log(`  ${skipped} left alone (they already hold an output)`)
}
console.log(`  ${Object.keys(all).length} agents now hold ${sats(total)} sats in total`)
if (real > 0) {
  console.log(`  ${real} of those are REAL imported outputs and were not touched`)
}
console.log('')
console.log('Budget (sats):')
console.log(describeBudget(budget))
console.log('')
console.log('Next: npm run test-pay')
