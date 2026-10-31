/**
 * `npm run test-pay` — one contribution from Lisa's agent to tiny-tls.
 *
 * Works in both modes, with no branch of its own: `contribute` builds, signs
 * and checks the transaction either way, and only the broadcast depends on
 * DRY_RUN. In live mode this spends real satoshis.
 *
 * Lisa's owner is her BSV Desktop identity, so her attestation comes from the
 * server (Phase 3 stored it). Without it the server will reject the
 * contribution for having no owner — which is correct, and the script says so
 * rather than pretending it worked.
 */
import { PrivateKey } from '@bsv/sdk'
import type { AgentAttestation } from '@upstream/shared/attestation'
import { loadBudget, sats } from '@upstream/shared/budget'
import { describeMode, loadRuntime } from '@upstream/shared/runtime'
import { loadKeys } from '@upstream/shared/keystore'
import { findProject } from '@upstream/shared/projects'
import { contribute, ContributeError } from './lib/contribute.ts'
import { dryRunAttestation } from './lib/dryRunOwners.ts'
import { getUtxo } from './lib/utxos.ts'

const runtime = loadRuntime(process.env)
const budget = loadBudget(process.env)

const PROJECT_ID = process.argv[2] ?? 'tiny-tls'

/** Lisa's owner attestation, as stored by Phase 3. */
async function lisaAttestation(agentPubKey: string): Promise<AgentAttestation | undefined> {
  try {
    const res = await fetch(`${runtime.serverUrl}/attestation`)
    if (!res.ok) return undefined
    const stored = (await res.json()) as Array<AgentAttestation & { label: string }>
    return stored.find(a => a.agentPubKey === agentPubKey)
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  console.log(describeMode(runtime))
  console.log('')

  const project = findProject(PROJECT_ID)
  if (project === undefined) {
    throw new Error(`unknown project "${PROJECT_ID}"`)
  }

  const keys = loadKeys()
  const agent = keys.lisa
  const before = getUtxo(agent.label)

  if (before === undefined) {
    console.error(`${agent.label} has no spendable output yet.`)
    console.error('')
    if (runtime.dryRun) {
      console.error('  npm run seed-agents          (dry-run coins)')
    } else {
      console.error('  fund the agents in the web app, or')
      console.error('  npm run import-funding <txid>  (after a manual Send)')
    }
    process.exitCode = 1
    return
  }

  console.log(`${agent.label} → ${project.name}`)
  console.log(`  agent address   ${agent.address}`)
  console.log(`  project address ${project.address}`)
  console.log(
    `  holding         ${sats(before.satoshis)} sats  (${before.synthetic ? 'synthetic dry-run coins' : `real, from ${before.origin}`})`
  )
  console.log(`  paying          ${sats(budget.contributionSats)} sats`)
  console.log('')

  // A real BSV Desktop attestation always wins. In dry-run, fall back to a
  // simulated owner so the flow can be exercised end to end; in live mode,
  // never — an unvouched contribution SHOULD be rejected.
  let attestation = await lisaAttestation(agent.pubKey)
  let simulated = false
  if (attestation === undefined && runtime.dryRun) {
    attestation = await dryRunAttestation(agent.label, agent.pubKey)
    simulated = true
    console.log('Owner: SIMULATED (dry run). BSV Desktop has not signed Lisa’s agent key yet,')
    console.log('so a stand-in owner from data/dry-run-owners.json is used for this run.')
    console.log('')
  } else if (attestation === undefined) {
    console.log('No owner attestation for Lisa, so the server will reject this contribution.')
    console.log('Sign her agent key in the web app (step 5) to make it count.')
    console.log('')
  } else {
    console.log('Owner: BSV Desktop attestation from the server.')
    console.log('')
  }

  const result = await contribute(
    {
      agentLabel: agent.label,
      agentKey: PrivateKey.fromHex(agent.privHex),
      projectId: PROJECT_ID,
      ...(attestation !== undefined ? { attestation } : {})
    },
    { budget, runtime }
  )

  console.log(`Transaction ${result.txid}`)
  console.log(`  output 0  ${sats(result.sats).padStart(8)} sats → ${project.id}`)
  console.log(`  output 1         0 sats → OP_RETURN UPSTREAM|${runtime.round}|${project.id}`)
  console.log(`  output 2  ${sats(result.change).padStart(8)} sats → change back to the agent`)
  console.log(`  fee       ${sats(result.fee).padStart(8)} sats`)
  console.log(`  size      ${String(result.rawTxHex.length / 2).padStart(8)} bytes`)
  console.log('')
  console.log('  signed and script-verified with the SDK: yes')
  console.log(`  broadcast: ${result.broadcast ? `yes, via ${runtime.arcadeUrl}` : 'NO (dry run)'}`)
  console.log(`  tally: ${result.accepted ? result.serverMessage : `REJECTED — ${result.serverMessage}`}`)
  if (simulated) console.log('  owner: simulated for dry-run, not stored as an attestation')
  console.log('')

  const after = getUtxo(agent.label)
  console.log(
    `  next input: ${after?.txid.slice(0, 12)}:${after?.vout} holding ${sats(after?.satoshis ?? 0)} sats`
  )
  console.log('  (the change chains straight into the next contribution)')
  console.log('')

  if (result.broadcast) {
    console.log(result.explorerUrl)
  } else {
    console.log(`Would be at: ${result.explorerUrl}`)
    console.log('Nothing was broadcast, so the explorer will not know this txid.')
    console.log('Set DRY_RUN=false in .env to go live.')
  }
}

main().catch((err: unknown) => {
  console.error('')
  console.error(err instanceof ContributeError ? err.message : (err as Error).message)
  process.exitCode = 1
})
