/**
 * Small tally-server helpers shared by the swarm, whale and sybil scripts.
 */
import { sats } from '@upstream/shared/budget'
import { PROJECTS } from '@upstream/shared/projects'
import type { Runtime } from '@upstream/shared/runtime'
import type { TallyRow } from '@upstream/shared'

export interface TallySummary {
  pool: number
  rows: TallyRow[]
  totalRaised: number
  totalMatched: number
  contributions: number
  owners: number
  rejected: number
}

/** Fail early, with a useful message, if the server is not there. */
export async function requireServer(runtime: Runtime): Promise<void> {
  let health: { round?: string } | null = null
  try {
    const res = await fetch(`${runtime.serverUrl}/health`)
    if (res.ok) health = (await res.json()) as { round?: string }
  } catch {
    // handled below
  }
  if (health === null) {
    throw new Error(`The tally server is not reachable at ${runtime.serverUrl}. Start it: npm run server`)
  }
  if (health.round !== undefined && health.round !== runtime.round) {
    throw new Error(`The server runs round "${health.round}", but ROUND is "${runtime.round}".`)
  }
}

export async function fetchTally(runtime: Runtime): Promise<TallySummary | null> {
  try {
    const res = await fetch(`${runtime.serverUrl}/tally`)
    return res.ok ? ((await res.json()) as TallySummary) : null
  } catch {
    return null
  }
}

export function printTally(t: TallySummary): void {
  console.log(`Tally — pool ${sats(t.pool)} sats`)
  console.log(
    `  ${t.contributions} contributions · ${t.owners} owners · ${sats(t.totalRaised)} raised · ` +
      `${sats(t.totalMatched)} matched · ${t.rejected} rejected`
  )
  console.log('')
  console.log('  project          supporters    raised     match')
  const rows = [...t.rows].sort((a, b) => b.match - a.match)
  for (const r of rows) {
    console.log(
      `  ${r.project.padEnd(16)} ${String(r.supporters).padStart(10)} ${sats(r.raised).padStart(9)} ${sats(r.match).padStart(9)}`
    )
  }
  for (const p of PROJECTS) {
    if (!t.rows.some(r => r.project === p.id)) {
      console.log(`  ${p.id.padEnd(16)} ${'—'.padStart(10)} ${'—'.padStart(9)} ${'—'.padStart(9)}`)
    }
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    if (signal?.aborted === true) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
