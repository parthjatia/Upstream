/**
 * Lisa's agent loop: model ⇄ tools, where every library tool pays its project.
 *
 * Each of the five library tools is wrapped in `paidTool` (agents/lib), so the
 * payment is a precondition of running the tool. Arguments are validated by a
 * dry call of the pure function first, so a malformed call from the model
 * costs nothing; only a call that will actually run is paid for.
 *
 * Contributions spend the agent's single chained UTXO, so tool calls run one at
 * a time even when the model asks for several in parallel.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PrivateKey } from '@bsv/sdk'
import type { AgentAttestation } from '@upstream/shared/attestation'
import type { Budget } from '@upstream/shared/budget'
import type { Runtime } from '@upstream/shared/runtime'
import { paidTool, type ContributionResult } from '../lib/contribute.ts'
import { TOOLS, ToolInputError, type ToolSpec } from './library.ts'
import {
  anthropicSession,
  openAiSession,
  type LlmConfig,
  type LlmSession,
  type ToolCall,
  type ToolDef,
  type ToolOutcome,
  type Turn
} from './llm.ts'
import { scriptedSession } from './scripted.ts'

export const TASK = "Build a one-page website for Lisa's bakery and save it to `data/lisa-bakery.html`."

/** The one tool that does not pay anyone: it is Lisa's own disk, not a library. */
export const SAVE_TOOL: ToolDef = {
  name: 'savePage',
  description:
    'Save the finished HTML page to data/lisa-bakery.html. Free. Call it once, with the complete document.',
  inputSchema: {
    type: 'object',
    properties: { html: { type: 'string', description: 'The complete HTML document.' } },
    required: ['html'],
    additionalProperties: false
  }
}

export const MAX_PAGE_CHARS = 200_000

export function systemPrompt(contributionSats: number, maxPaidCalls: number): string {
  const lines = TOOLS.map(t => `- ${t.name} (pays the open-source project "${t.projectId}")`)
  return [
    "You are Lisa's web agent. Lisa runs a small neighbourhood bakery.",
    '',
    'You have five library tools. Every call to one of them automatically pays its open-source',
    `project ${contributionSats} satoshis on the BSV blockchain, before the tool runs:`,
    ...lines,
    '- savePage (free) writes the finished page to disk.',
    '',
    'How to work:',
    '- Use each of the five library tools at least once, where it genuinely helps the page:',
    '  a colour palette for the styles, a nicely formatted date (e.g. an opening or "baked fresh" date),',
    '  a spell-check of your marketing copy, a SHA-256 fingerprint shown in the footer (e.g. of the menu),',
    '  and minify the finished HTML with compressText before saving.',
    `- Keep it efficient: at most ${maxPaidCalls} paid calls in total. Do not call a tool just to pay.`,
    '- Write a complete, self-contained, responsive HTML document with inline CSS and no external assets.',
    '  Invent plausible bakery details (name, menu with prices, opening hours, address).',
    '- Call savePage exactly once with the final (minified) HTML, then reply with a one-paragraph summary.'
  ].join('\n')
}

export interface ToolCallLog {
  at: string
  turn: number
  tool: string
  projectId: string | null
  ok: boolean
  error?: string
  paid: boolean
  txid?: string
  sats?: number
  fee?: number
  change?: number
  broadcast?: boolean
  accepted?: boolean
  serverMessage?: string
  explorerUrl?: string
}

export interface RunOptions {
  llm: LlmConfig
  budget: Budget
  runtime: Runtime
  agent: { label: string; key: PrivateKey }
  attestation?: AgentAttestation
  /** Absolute path of the page to write. */
  outFile: string
  /** JSONL log of every tool call, with full txids. */
  logFile?: string
  maxTurns?: number
  maxPaidCalls?: number
  print?: (line: string) => void
  fetchImpl?: typeof fetch
  /** Override the session, for tests. */
  session?: LlmSession
}

export interface RunResult {
  calls: ToolCallLog[]
  payments: ContributionResult[]
  /** Distinct projects that received at least one payment. */
  projectsPaid: string[]
  savedTo?: string
  savedBytes?: number
  finalText: string
  stop: Turn['stop'] | 'max_turns'
}

export class AgentAbort extends Error {}

export function createSession(cfg: LlmConfig, system: string, fetchImpl?: typeof fetch): LlmSession {
  const tools: ToolDef[] = [
    ...TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as unknown as Record<string, unknown> })),
    SAVE_TOOL
  ]
  const init = { system, task: TASK, tools, ...(fetchImpl ? { fetchImpl } : {}) }
  switch (cfg.provider) {
    case 'anthropic':
      return anthropicSession(cfg, init)
    case 'openai':
      return openAiSession(cfg, init)
    case 'scripted':
      return scriptedSession()
  }
}

const short = (txid: string): string => `${txid.slice(0, 12)}…`

export async function runLisa(opts: RunOptions): Promise<RunResult> {
  const { budget, runtime } = opts
  const print = opts.print ?? ((l: string) => console.log(l))
  const maxTurns = opts.maxTurns ?? 20
  const maxPaidCalls = opts.maxPaidCalls ?? 25

  const session =
    opts.session ?? createSession(opts.llm, systemPrompt(budget.contributionSats, maxPaidCalls), opts.fetchImpl)

  const calls: ToolCallLog[] = []
  const payments: ContributionResult[] = []
  let savedTo: string | undefined
  let savedBytes: number | undefined
  let turnNo = 0

  // One paid wrapper per tool. `onPaid` hands us the receipt for this call.
  let lastReceipt: ContributionResult | undefined
  const paid = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
  for (const spec of TOOLS) {
    paid.set(
      spec.name,
      paidTool(
        spec.projectId,
        spec.run,
        {
          agentLabel: opts.agent.label,
          agentKey: opts.agent.key,
          ...(opts.attestation ? { attestation: opts.attestation } : {})
        },
        { budget, runtime, onPaid: r => (lastReceipt = r) }
      )
    )
  }

  const record = (entry: ToolCallLog): void => {
    calls.push(entry)
    if (opts.logFile !== undefined) {
      mkdirSync(dirname(opts.logFile), { recursive: true })
      appendFileSync(opts.logFile, `${JSON.stringify(entry)}\n`, 'utf8')
    }
  }

  const execute = async (call: ToolCall): Promise<ToolOutcome> => {
    const base = { at: new Date().toISOString(), turn: turnNo, tool: call.name }
    const fail = (projectId: string | null, error: string): ToolOutcome => {
      record({ ...base, projectId, ok: false, error, paid: false })
      print(`  ✗ ${call.name.padEnd(15)} not run, not paid — ${error}`)
      return { id: call.id, content: `Error: ${error}`, isError: true }
    }

    if (call.parseError !== undefined) return fail(null, `arguments were not valid JSON (${call.parseError})`)

    if (call.name === SAVE_TOOL.name) {
      const html = call.input.html
      if (typeof html !== 'string' || html.trim() === '') return fail(null, '"html" must be a non-empty string')
      if (html.length > MAX_PAGE_CHARS) return fail(null, `page is over ${MAX_PAGE_CHARS} characters`)
      if (!/<html[\s>]/i.test(html)) return fail(null, 'that is not a complete HTML document (no <html> tag)')
      mkdirSync(dirname(opts.outFile), { recursive: true })
      writeFileSync(opts.outFile, html, 'utf8')
      savedTo = opts.outFile
      savedBytes = Buffer.byteLength(html, 'utf8')
      record({ ...base, projectId: null, ok: true, paid: false })
      print(`  ✓ ${'savePage'.padEnd(15)} free         wrote ${savedBytes} bytes → ${opts.outFile}`)
      return { id: call.id, content: JSON.stringify({ saved: true, bytes: savedBytes }), isError: false }
    }

    const spec: ToolSpec | undefined = TOOLS.find(t => t.name === call.name)
    const run = paid.get(call.name)
    if (spec === undefined || run === undefined) return fail(null, `unknown tool "${call.name}"`)

    if (payments.length >= maxPaidCalls) {
      return fail(spec.projectId, `paid-call limit of ${maxPaidCalls} reached for this run; finish with what you have`)
    }

    // Validate before paying: the functions are pure, so a dry call is free.
    try {
      spec.run(call.input)
    } catch (err) {
      if (err instanceof ToolInputError) return fail(spec.projectId, err.message)
      throw err
    }

    lastReceipt = undefined
    let output: unknown
    try {
      output = await run(call.input)
    } catch (err) {
      // A payment failure (e.g. out of funds) ends the run: no more tools can be paid for.
      const message = (err as Error).message
      record({ ...base, projectId: spec.projectId, ok: false, error: message, paid: lastReceipt !== undefined })
      print(`  ✗ ${call.name.padEnd(15)} payment to ${spec.projectId} failed — ${message}`)
      throw new AgentAbort(`payment for ${call.name} failed: ${message}`)
    }

    const receipt = lastReceipt as ContributionResult | undefined
    if (receipt === undefined) throw new AgentAbort(`${call.name} ran without a payment receipt`)
    payments.push(receipt)
    record({
      ...base,
      projectId: spec.projectId,
      ok: true,
      paid: true,
      txid: receipt.txid,
      sats: receipt.sats,
      fee: receipt.fee,
      change: receipt.change,
      broadcast: receipt.broadcast,
      accepted: receipt.accepted,
      serverMessage: receipt.serverMessage,
      explorerUrl: receipt.explorerUrl
    })
    print(
      `  ✓ ${call.name.padEnd(15)} paid ${String(receipt.sats).padStart(3)} sats → ${spec.projectId.padEnd(13)} ` +
        `tx ${short(receipt.txid)}  ${receipt.broadcast ? 'broadcast' : 'not broadcast'}  ` +
        `tally: ${receipt.accepted ? receipt.serverMessage : `REJECTED (${receipt.serverMessage})`}`
    )
    return { id: call.id, content: JSON.stringify(output), isError: false }
  }

  let turn = await session.start()
  let stop: RunResult['stop'] = turn.stop
  for (;;) {
    turnNo++
    if (turn.text !== '') print(`\n🤖 ${turn.text}`)
    if (turn.stop !== 'tool_use' || turn.calls.length === 0) {
      stop = turn.stop
      break
    }
    if (turnNo >= maxTurns) {
      stop = 'max_turns'
      break
    }
    const results: ToolOutcome[] = []
    for (const c of turn.calls) results.push(await execute(c))
    turn = await session.continue(results)
  }

  return {
    calls,
    payments,
    projectsPaid: [...new Set(payments.map(p => p.projectId))],
    ...(savedTo !== undefined ? { savedTo } : {}),
    ...(savedBytes !== undefined ? { savedBytes } : {}),
    finalText: turn.text,
    stop
  }
}
