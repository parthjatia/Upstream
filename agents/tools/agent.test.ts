import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadBudget } from '@upstream/shared/budget'
import { loadRuntime } from '@upstream/shared/runtime'
import type { KeyRecord, KeyStore } from '@upstream/shared/keystore'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-lisa-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterAll(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

const { runLisa, createSession, systemPrompt } = await import('./agent.ts')
const { loadLlmConfig, describeLlm, DEFAULT_MODELS } = await import('./llm.ts')
const { writeUtxos, seedSyntheticFunding, getUtxo } = await import('../lib/utxos.ts')
const { dryRunAttestation } = await import('../lib/dryRunOwners.ts')

const budget = loadBudget({ SWARM_SIZE: '1', SYBIL_SIZE: '1' })
// Unreachable server: reporting fails softly, payments are still built and signed.
const runtime = loadRuntime({ DRY_RUN: 'true', SERVER_URL: 'http://127.0.0.1:1' })

const key = (label: string): KeyRecord => {
  const priv = PrivateKey.fromRandom()
  return {
    label,
    privHex: priv.toHex(),
    wif: priv.toWif([0x80]),
    pubKey: priv.toPublicKey().toString(),
    address: priv.toAddress([0x00])
  }
}
const keys: KeyStore = {
  projects: [],
  lisa: key('lisa-agent'),
  swarm: [{ agent: key('swarm-agent-001'), owner: key('swarm-owner-001') }],
  whale: { agent: key('whale-agent'), owner: key('whale-owner') },
  sybil: [key('sybil-agent-001')]
}
const agent = { label: keys.lisa.label, key: PrivateKey.fromHex(keys.lisa.privHex) }

beforeEach(() => {
  writeUtxos({})
  seedSyntheticFunding(keys, budget)
  rmSync(join(dir, 'lisa-bakery.html'), { force: true })
  rmSync(join(dir, 'lisa-log.jsonl'), { force: true })
})

const SECRET = 'sk-test-SECRET-never-print-me'

describe('LLM config', () => {
  it('falls back to the scripted planner only in dry-run', () => {
    expect(loadLlmConfig({}, { dryRun: true }).provider).toBe('scripted')
    expect(() => loadLlmConfig({}, { dryRun: false })).toThrow(/LLM_API_KEY/)
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'scripted' }, { dryRun: false })).toThrow()
  })

  it('reads provider, key and model, and never shows the key', () => {
    const a = loadLlmConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: SECRET }, { dryRun: false })
    expect(a).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: SECRET })
    const o = loadLlmConfig({ LLM_PROVIDER: 'OpenAI', LLM_API_KEY: SECRET, LLM_MODEL: 'm' }, { dryRun: true })
    expect(o).toMatchObject({ provider: 'openai', model: 'm' })
    expect(describeLlm(a)).not.toContain(SECRET)
    expect(() => loadLlmConfig({ LLM_PROVIDER: 'gemini' }, { dryRun: true })).toThrow()
  })

  it('defaults anthropic to claude-sonnet-5-5 and openai to gpt-5', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-sonnet-5-5')
    expect(DEFAULT_MODELS.openai).toBe('gpt-5')
    expect(
      loadLlmConfig({ LLM_PROVIDER: 'openai', LLM_API_KEY: SECRET }, { dryRun: false }).model
    ).toBe('gpt-5')
  })

  it('reads ONLY the LLM_* names, never a provider-specific alias', () => {
    // Two ways to set the same thing is how a .env ends up running a model
    // nobody chose, so the old names must have no effect at all.
    expect(() =>
      loadLlmConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: SECRET }, { dryRun: false })
    ).toThrow(/LLM_API_KEY/)

    const withOldModel = loadLlmConfig(
      { LLM_PROVIDER: 'anthropic', LLM_API_KEY: SECRET, ANTHROPIC_MODEL: 'claude-sonnet-5' },
      { dryRun: false }
    )
    expect(withOldModel.model).toBe('claude-sonnet-5-5')

    expect(() =>
      loadLlmConfig({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: SECRET }, { dryRun: false })
    ).toThrow(/LLM_API_KEY/)
  })
})

describe('runLisa', () => {
  it('scripted run: five paid tool calls, one per project, page saved, txids logged', async () => {
    const lines: string[] = []
    const attestation = await dryRunAttestation(agent.label, keys.lisa.pubKey)
    const outFile = join(dir, 'lisa-bakery.html')
    const logFile = join(dir, 'lisa-log.jsonl')
    const before = getUtxo(agent.label)!.satoshis

    const r = await runLisa({
      llm: loadLlmConfig({}, { dryRun: true }),
      budget,
      runtime,
      agent,
      attestation,
      outFile,
      logFile,
      print: l => lines.push(l)
    })

    expect(r.stop).toBe('end')
    expect(r.payments).toHaveLength(5)
    expect(r.projectsPaid.sort()).toEqual(['color-text', 'compress-lite', 'log-helper', 'stream-utils', 'tiny-tls'])
    expect(new Set(r.payments.map(p => p.txid)).size).toBe(5)
    expect(r.payments.every(p => !p.broadcast)).toBe(true)

    const html = readFileSync(outFile, 'utf8')
    expect(html).toMatch(/<html/)
    expect(html).toContain("Lisa's Bakery")
    expect(html).toContain('sha256-')
    expect(html).not.toContain('sourdouh') // spell-checked

    const log = readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { paid: boolean; txid?: string })
    expect(log.filter(e => e.paid).map(e => e.txid)).toEqual(r.payments.map(p => p.txid))
    for (const p of r.payments) expect(lines.join('\n')).toContain(p.txid.slice(0, 12))

    const spent = r.payments.reduce((a, p) => a + p.sats + p.fee, 0)
    expect(getUtxo(agent.label)!.satoshis).toBe(before - spent)
  })

  it('does not pay for a malformed call, and refuses calls past the limit', async () => {
    let step = 0
    const r = await runLisa({
      llm: loadLlmConfig({}, { dryRun: true }),
      budget,
      runtime,
      agent,
      outFile: join(dir, 'lisa-bakery.html'),
      maxPaidCalls: 1,
      print: () => {},
      session: {
        start: async () => ({
          text: '',
          stop: 'tool_use',
          calls: [
            { id: 'a', name: 'spellCheck', input: { text: 7 } },
            { id: 'b', name: 'secureHash', input: { text: 'x' } },
            { id: 'c', name: 'secureHash', input: { text: 'y' } },
            { id: 'd', name: 'nope', input: {} }
          ]
        }),
        continue: async results => {
          step++
          expect(results.map(x => x.isError)).toEqual([true, false, true, true])
          return { text: 'ok', stop: 'end', calls: [] }
        }
      }
    })
    expect(step).toBe(1)
    expect(r.payments).toHaveLength(1)
    expect(r.savedTo).toBeUndefined()
  })
})

/** A fake provider endpoint that replays the scripted plan as real API JSON. */
function fakeApi(kind: 'anthropic' | 'openai'): { fetchImpl: typeof fetch; bodies: unknown[]; headers: Array<Record<string, string>> } {
  const bodies: unknown[] = []
  const headers: Array<Record<string, string>> = []
  const plan: Array<Array<{ name: string; input: Record<string, unknown> }>> = [
    [
      { name: 'generatePalette', input: { base: 'wheat' } },
      { name: 'formatDate', input: { date: '2026-11-02' } },
      { name: 'spellCheck', input: { text: 'Delicous bread' } }
    ],
    [{ name: 'secureHash', input: { text: 'menu' } }],
    [{ name: 'compressText', input: { text: '<html>  <body> hi </body> </html>' } }],
    [{ name: 'savePage', input: { html: '<html><body>Lisa</body></html>' } }],
    []
  ]
  let i = 0
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    headers.push(init?.headers as Record<string, string>)
    const calls = plan[i] ?? []
    const turn = i++
    const body =
      kind === 'anthropic'
        ? {
            content: [
              { type: 'thinking', thinking: '', signature: 'sig' },
              { type: 'text', text: calls.length ? `step ${turn}` : 'All done.' },
              ...calls.map((c, j) => ({ type: 'tool_use', id: `tu_${turn}_${j}`, name: c.name, input: c.input }))
            ],
            stop_reason: calls.length ? 'tool_use' : 'end_turn'
          }
        : {
            choices: [
              {
                finish_reason: calls.length ? 'tool_calls' : 'stop',
                message: {
                  role: 'assistant',
                  content: calls.length ? null : 'All done.',
                  ...(calls.length
                    ? {
                        tool_calls: calls.map((c, j) => ({
                          id: `call_${turn}_${j}`,
                          type: 'function',
                          function: { name: c.name, arguments: JSON.stringify(c.input) }
                        }))
                      }
                    : {})
                }
              }
            ]
          }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, bodies, headers }
}

describe.each(['anthropic', 'openai'] as const)('%s adapter', kind => {
  it('drives the loop with real request shapes', async () => {
    const llm = loadLlmConfig({ LLM_PROVIDER: kind, LLM_API_KEY: SECRET }, { dryRun: true })
    const api = fakeApi(kind)
    const lines: string[] = []
    const r = await runLisa({
      llm,
      budget,
      runtime,
      agent,
      outFile: join(dir, 'lisa-bakery.html'),
      print: l => lines.push(l),
      session: createSession(llm, systemPrompt(10, 25), api.fetchImpl)
    })

    expect(r.stop).toBe('end')
    expect(r.finalText).toBe('All done.')
    expect(r.payments).toHaveLength(5)
    expect(existsSync(join(dir, 'lisa-bakery.html'))).toBe(true)
    expect(lines.join('\n')).not.toContain(SECRET)

    const second = api.bodies[1] as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools: unknown[] }
    expect(second.tools).toHaveLength(6)
    if (kind === 'anthropic') {
      expect(api.headers[0]!['x-api-key']).toBe(SECRET)
      expect((api.bodies[0] as { fallbacks?: string }).fallbacks).toBe('default')
      // Assistant content (thinking included) is replayed unchanged; all
      // three results come back in ONE user message.
      const [, assistant, user] = second.messages
      expect((assistant!.content as Array<{ type: string }>)[0]!.type).toBe('thinking')
      expect((user!.content as Array<{ type: string }>).map(b => b.type)).toEqual(['tool_result', 'tool_result', 'tool_result'])
    } else {
      expect(api.headers[0]!.authorization).toBe(`Bearer ${SECRET}`)
      expect(second.messages.filter(m => m.role === 'tool')).toHaveLength(3)
    }
  })
})
