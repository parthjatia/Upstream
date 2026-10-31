/**
 * `npm run whale` — one big contribution of WHALE_CONTRIBUTION_SATS to tiny-tls.
 *
 * The whale has one owner, so however much it pays it is one supporter: under
 * quadratic funding a single large payment earns no matching. That is the
 * point of the demo's "whale vs crowd" moment.
 *
 * With DRY_RUN=false this spends real satoshis.
 */
import { PrivateKey } from '@bsv/sdk'
import { loadBudget, sats } from '@upstream/shared/budget'
import { loadKeys } from '@upstream/shared/keystore'
import { findProject } from '@upstream/shared/projects'
import { describeMode, loadRuntime } from '@upstream/shared/runtime'
import { contribute, ContributeError } from './lib/contribute.ts'
import { fetchTally, printTally, requireServer } from './lib/swarm/server.ts'
import { getUtxo } from './lib/utxos.ts'

const runtime = loadRuntime(process.env)
const budget = loadBudget(process.env)
const PROJECT_ID = 'tiny-tls'

async function main(): Promise<void> {
  console.log(describeMode(runtime))
  console.log('')
  await requireServer(runtime)

  const project = findProject(PROJECT_ID)
  if (project === undefined) throw new Error(`unknown project "${PROJECT_ID}"`)

  const { whale } = loadKeys()
  const utxo = getUtxo(whale.agent.label)
  if (utxo === undefined) {
    console.error(`${whale.agent.label} has no spendable output.`)
    console.error(runtime.dryRun ? '  npm run seed-agents' : '  fund the agents in the web app first')
    process.exitCode = 1
    return
  }

  console.log(`Whale → ${project.name}`)
  console.log(`  holding  ${sats(utxo.satoshis)} sats`)
  console.log(`  paying   ${sats(budget.whaleContributionSats)} sats in one transaction`)
  console.log('')

  const result = await contribute(
    {
      agentLabel: whale.agent.label,
      agentKey: PrivateKey.fromHex(whale.agent.privHex),
      projectId: PROJECT_ID,
      sats: budget.whaleContributionSats,
      owner: PrivateKey.fromHex(whale.owner.privHex)
    },
    { budget, runtime }
  )

  console.log(`Transaction ${result.txid}`)
  console.log(`  ${sats(result.sats)} sats → ${PROJECT_ID}, fee ${sats(result.fee)}, change ${sats(result.change)}`)
  console.log(`  broadcast: ${result.broadcast ? `yes, via ${runtime.arcadeUrl}` : 'NO (dry run)'}`)
  console.log(`  tally: ${result.accepted ? result.serverMessage : `REJECTED — ${result.serverMessage}`}`)
  console.log(result.broadcast ? `  ${result.explorerUrl}` : `  would be at ${result.explorerUrl}`)
  console.log('')

  const tally = await fetchTally(runtime)
  if (tally !== null) {
    printTally(tally)
    const row = tally.rows.find(r => r.project === PROJECT_ID)
    console.log('')
    console.log(
      `tiny-tls raised ${sats(row?.raised ?? 0)} from ${row?.supporters ?? 0} supporter(s) ` +
        `and is matched ${sats(row?.match ?? 0)}: one owner is one voice, however rich.`
    )
  }
  if (!result.accepted) process.exitCode = 1
}

main().catch((err: unknown) => {
  console.error('')
  console.error(err instanceof ContributeError ? err.message : (err as Error).message)
  process.exitCode = 1
})
