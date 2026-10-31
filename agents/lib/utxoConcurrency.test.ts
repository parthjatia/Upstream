/**
 * The shared-file race, and the proof it is gone.
 *
 * `swarm`, `whale`, `lisa` and `sybil` are separate processes. With every agent
 * in one `data/utxos.json`, `putUtxo` read the whole file, changed one entry and
 * wrote it all back, so two processes could interleave and one write would
 * silently discard the other's. The agent it discarded would still be holding an
 * output it had already spent: nothing visible in dry-run, a double spend that
 * Arcade rejects when live.
 *
 * These tests run REAL concurrent processes, because the bug only exists
 * between processes — within one process the old code was fine.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getUtxo, putUtxo, readUtxos, utxoDir, writeUtxos, type AgentUtxo } from './utxos.ts'

const REPO = join(import.meta.dirname, '..', '..')
const FIXTURE = join('agents', 'lib', 'utxoWriter.fixture.ts')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-utxo-race-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterEach(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

interface WorkerResult {
  agent: string
  satoshis: number
  vout: number
}

/** Run the fixture in its own process, sharing only UPSTREAM_DATA_DIR. */
async function writer(agent: string, iterations: number, startSats: number): Promise<WorkerResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'), FIXTURE, agent, String(iterations), String(startSats)],
      { cwd: REPO, env: { ...process.env, UPSTREAM_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`${agent} exited ${code}: ${err.trim() || out.trim()}`))
        return
      }
      const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop()
      if (line === undefined) {
        reject(new Error(`${agent} printed no result: ${out.trim()} ${err.trim()}`))
        return
      }
      resolve(JSON.parse(line) as WorkerResult)
    })
  })
}

const seed = (agent: string, satoshis: number): AgentUtxo => ({
  agent,
  txid: 'b'.repeat(64),
  vout: 0,
  satoshis,
  lockingScriptHex: '76a914' + '11'.repeat(20) + '88ac',
  sourceTxHex: '',
  synthetic: true,
  origin: 'synthetic',
  updatedAt: new Date().toISOString()
})

describe('per-agent UTXO files', () => {
  it('gives each agent its own file', () => {
    putUtxo(seed('lisa-agent', 5_000))
    putUtxo(seed('whale-agent', 20_000))

    expect(existsSync(join(utxoDir(), 'lisa-agent.json'))).toBe(true)
    expect(existsSync(join(utxoDir(), 'whale-agent.json'))).toBe(true)
    // The single shared file is gone, which is the whole point.
    expect(existsSync(join(dir, 'utxos.json'))).toBe(false)
  })

  it('reads every agent back as one map', () => {
    putUtxo(seed('lisa-agent', 5_000))
    putUtxo(seed('swarm-agent-001', 1_500))
    expect(Object.keys(readUtxos()).sort()).toEqual(['lisa-agent', 'swarm-agent-001'])
    expect(readUtxos()['lisa-agent']?.satoshis).toBe(5_000)
  })

  it('writing one agent leaves the others untouched', () => {
    putUtxo(seed('lisa-agent', 5_000))
    putUtxo(seed('whale-agent', 20_000))
    putUtxo({ ...seed('lisa-agent', 4_989), origin: 'change' })

    expect(getUtxo('lisa-agent')?.satoshis).toBe(4_989)
    expect(getUtxo('whale-agent')?.satoshis).toBe(20_000)
  })

  it('refuses a label that would escape the directory', () => {
    expect(() => putUtxo(seed('../escape', 1))).toThrow(/not a usable agent label/)
    expect(() => getUtxo('..')).toThrow(/not a usable agent label/)
    expect(() => getUtxo('a/b')).toThrow(/not a usable agent label/)
  })

  it('treats a corrupt record as no output rather than crashing', () => {
    putUtxo(seed('lisa-agent', 5_000))
    writeFileSync(join(utxoDir(), 'lisa-agent.json'), '{ not json', 'utf8')
    expect(getUtxo('lisa-agent')).toBeUndefined()
    expect(readUtxos()['lisa-agent']).toBeUndefined()
  })

  it('migrates a legacy data/utxos.json without losing balances', () => {
    writeFileSync(
      join(dir, 'utxos.json'),
      JSON.stringify({
        'lisa-agent': seed('lisa-agent', 4_321),
        'whale-agent': seed('whale-agent', 19_000)
      }),
      'utf8'
    )

    expect(getUtxo('lisa-agent')?.satoshis).toBe(4_321)
    expect(getUtxo('whale-agent')?.satoshis).toBe(19_000)
    // Kept, renamed rather than deleted, so nothing is destroyed.
    expect(existsSync(join(dir, 'utxos.json'))).toBe(false)
    expect(existsSync(join(dir, 'utxos.json.migrated'))).toBe(true)
  })

  it('never lets the legacy file overwrite a newer per-agent record', () => {
    putUtxo({ ...seed('lisa-agent', 10), origin: 'change' })
    writeFileSync(join(dir, 'utxos.json'), JSON.stringify({ 'lisa-agent': seed('lisa-agent', 9_999) }), 'utf8')
    expect(getUtxo('lisa-agent')?.satoshis).toBe(10)
  })

  it('writeUtxos replaces the whole set, for a deliberate reset', () => {
    putUtxo(seed('lisa-agent', 5_000))
    writeUtxos({ 'whale-agent': seed('whale-agent', 20_000) })
    expect(Object.keys(readUtxos())).toEqual(['whale-agent'])
  })
})

describe('two processes at once', () => {
  // tsx start-up dominates; the writes themselves are fast.
  it('does not lose either agent when both write concurrently', async () => {
    const [lisa, whale] = await Promise.all([
      writer('lisa-agent', 120, 5_000),
      writer('whale-agent', 120, 20_000)
    ])

    // Each process accounted for its own agent.
    expect(lisa.satoshis).toBe(5_000 - 120)
    expect(whale.satoshis).toBe(20_000 - 120)

    // And the files on disk agree — neither write discarded the other.
    expect(getUtxo('lisa-agent')?.satoshis).toBe(4_880)
    expect(getUtxo('whale-agent')?.satoshis).toBe(19_880)
  }, 120_000)

  it('keeps all four agent families correct under concurrency', async () => {
    const results = await Promise.all([
      writer('lisa-agent', 60, 5_000),
      writer('swarm-agent-001', 60, 1_500),
      writer('whale-agent', 60, 20_000),
      writer('sybil-agent-001', 60, 200)
    ])

    expect(results.map(r => r.satoshis)).toEqual([4_940, 1_440, 19_940, 140])

    const all = readUtxos()
    expect(Object.keys(all).sort()).toEqual([
      'lisa-agent',
      'swarm-agent-001',
      'sybil-agent-001',
      'whale-agent'
    ])
    for (const r of results) {
      expect(all[r.agent]?.satoshis, r.agent).toBe(r.satoshis)
    }
  }, 120_000)

  it('leaves no temporary files behind', async () => {
    await Promise.all([writer('lisa-agent', 40, 5_000), writer('whale-agent', 40, 20_000)])
    const leftovers = Object.keys(readUtxos())
    expect(leftovers).toHaveLength(2)
    // Atomic writes use a .tmp suffix in the same directory and rename it away.
    const names = readFileSync(join(utxoDir(), 'lisa-agent.json'), 'utf8')
    expect(names.startsWith('{')).toBe(true)
    expect(existsSync(join(utxoDir(), 'lisa-agent.json.tmp'))).toBe(false)
  }, 120_000)
})
