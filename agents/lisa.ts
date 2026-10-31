/**
 * `npm run lisa` — Lisa's AI agent (PROJECT_BRIEF.md Phase 6).
 *
 * An LLM with tool calling builds a one-page website for Lisa's bakery. Its
 * five library tools each pay their open-source project CONTRIBUTION_SATS per
 * call, through `paidTool`, from Lisa's agent key. Every tool call is logged
 * with its payment txid, on screen and in data/lisa-log.jsonl.
 *
 * Settings (.env): LLM_PROVIDER (anthropic | openai), LLM_API_KEY, optional
 * LLM_MODEL and LISA_MAX_TOOL_CALLS. The key is never printed.
 *
 * In DRY_RUN with no key, a scripted planner stands in for the model so the
 * payment path can be tested; the run says so and does not count as Phase 6.
 */
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { loadBudget, sats } from '@upstream/shared/budget'
import { DATA_DIR, loadKeys } from '@upstream/shared/keystore'
import { describeMode, loadRuntime } from '@upstream/shared/runtime'
import { getUtxo } from './lib/utxos.ts'
import { AgentAbort, runLisa, TASK } from './tools/agent.ts'
import { describeLlm, loadLlmConfig, LlmError } from './tools/llm.ts'
import { resolveLisaOwner } from './tools/owner.ts'
import { TOOLS } from './tools/library.ts'

const REQUIRED_PAYMENTS = 5

function readLimit(raw: string | undefined, def: number): number {
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`LISA_MAX_TOOL_CALLS="${raw}" must be a positive integer`)
  return n
}

async function serverUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`)
    return res.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const runtime = loadRuntime(process.env)
  const budget = loadBudget(process.env)
  const llm = loadLlmConfig(process.env, { dryRun: runtime.dryRun })
  const maxPaidCalls = readLimit(process.env.LISA_MAX_TOOL_CALLS, 25)
  const dataDir = process.env.UPSTREAM_DATA_DIR ?? DATA_DIR

  console.log(describeMode(runtime))
  console.log(`Model: ${describeLlm(llm)}`)
  if (llm.provider === 'scripted') {
    console.log('  ⚠ No LLM is being called. Set LLM_PROVIDER and LLM_API_KEY in .env for the real agent.')
  }
  console.log('')

  if (!(await serverUp(runtime.serverUrl))) {
    console.error(`The tally server is not answering at ${runtime.serverUrl}.`)
    console.error('Start it first:  npm run server')
    process.exitCode = 1
    return
  }

  const agent = loadKeys().lisa
  const utxo = getUtxo(agent.label)
  if (utxo === undefined) {
    console.error(`${agent.label} has no spendable output yet.`)
    console.error(runtime.dryRun ? '  npm run seed-agents          (dry-run coins)' : '  npm run import-funding <txid>')
    process.exitCode = 1
    return
  }

  // Rough affordability check: each paid call costs the contribution plus a ~1 sat fee.
  const affordable = Math.floor(utxo.satoshis / (budget.contributionSats + 1))
  const limit = Math.min(maxPaidCalls, affordable)
  if (limit < REQUIRED_PAYMENTS) {
    console.error(
      `${agent.label} holds ${sats(utxo.satoshis)} sats: enough for ${affordable} paid calls, fewer than ${REQUIRED_PAYMENTS}.`
    )
    process.exitCode = 1
    return
  }

  const owner = await resolveLisaOwner(runtime, agent)
  const ownerLine = {
    'bsv-desktop': 'BSV Desktop attestation from the server',
    simulated: 'SIMULATED owner (dry run; BSV Desktop has not signed yet)',
    none: 'NONE — the server will reject these payments. Sign her agent key in the web app.'
  }[owner.source]

  console.log(`Task:    ${TASK}`)
  console.log(`Agent:   ${agent.label} ${agent.address}, holding ${sats(utxo.satoshis)} sats${utxo.synthetic ? ' (synthetic)' : ''}`)
  console.log(`Owner:   ${ownerLine}`)
  console.log(`Pays:    ${sats(budget.contributionSats)} sats per library call, at most ${limit} calls`)
  console.log(`Tools:   ${TOOLS.map(t => `${t.name}→${t.projectId}`).join(', ')}, savePage (free)`)

  const logFile = join(dataDir, 'lisa-log.jsonl')
  const result = await runLisa({
    llm,
    budget,
    runtime,
    agent: { label: agent.label, key: PrivateKey.fromHex(agent.privHex) },
    ...(owner.attestation ? { attestation: owner.attestation } : {}),
    outFile: join(dataDir, 'lisa-bakery.html'),
    logFile,
    maxPaidCalls: limit
  })

  const spent = result.payments.reduce((a, p) => a + p.sats + p.fee, 0)
  const counted = result.payments.filter(p => p.accepted).length

  console.log('')
  console.log('──────── Summary ────────')
  console.log(`Payments:  ${result.payments.length} (${counted} counted by the tally), ${sats(spent)} sats incl. fees`)
  console.log(`Projects:  ${result.projectsPaid.join(', ') || 'none'}`)
  console.log(`Page:      ${result.savedTo ? `${result.savedTo} (${result.savedBytes} bytes)` : 'NOT SAVED'}`)
  console.log(`Log:       ${logFile}`)
  console.log('')
  for (const p of result.payments) {
    console.log(`  ${p.projectId.padEnd(14)} ${p.txid}  ${p.broadcast ? p.explorerUrl : '(dry run, not broadcast)'}`)
  }

  const problems: string[] = []
  if (result.savedTo === undefined) problems.push('the page was not saved')
  if (result.payments.length < REQUIRED_PAYMENTS) {
    problems.push(`only ${result.payments.length} payments (need ≥ ${REQUIRED_PAYMENTS})`)
  }
  if (counted < result.payments.length) problems.push(`${result.payments.length - counted} payment(s) not counted by the tally`)
  if (result.stop !== 'end') problems.push(`the agent stopped with "${result.stop}"`)

  console.log('')
  if (problems.length > 0) {
    console.log(`Not done: ${problems.join('; ')}.`)
    process.exitCode = 1
  } else if (llm.provider === 'scripted') {
    console.log('Payment path OK end to end — but this was the SCRIPTED planner, not an LLM.')
  } else {
    console.log(`Done: the agent built the page and made ${result.payments.length} payments.`)
  }
}

main().catch((err: unknown) => {
  console.error('')
  console.error(err instanceof AgentAbort || err instanceof LlmError ? err.message : (err as Error).stack ?? String(err))
  process.exitCode = 1
})
