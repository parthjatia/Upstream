import { BUDGET_DEFAULTS } from '@upstream/shared/budget'
import { quadraticMatch, type C } from '@upstream/shared/quadratic'
import type { Tally } from '../../server/src/contributions'

export type Source = 'lisa' | 'swarm' | 'whale' | 'rejected'
export interface Activity {
  id: string
  project: string
  label: string
  sats: number
  source: Source
  dryRun: boolean
  txid?: string
  reason?: string
}
export interface DemoState {
  step: number
  contributions: C[]
  feed: Activity[]
  pool: number
  rejected: number
}
export const DEMO_STEPS = 62
export const emptyDemo = (): DemoState => ({
  step: 0,
  contributions: [],
  feed: [],
  pool: BUDGET_DEFAULTS.sponsorPoolSats,
  rejected: 0
})
export function demoPhase(step: number): number {
  return step < 5 ? 0 : step < 45 ? 1 : step < 52 ? 2 : 3
}
export function advanceDemo(state: DemoState): DemoState {
  const i = state.step
  if (i >= DEMO_STEPS) return state
  const phase = demoPhase(i)
  // Let the whale comparison remain readable before the rejection sequence.
  if (phase === 2 && i > 45) return { ...state, step: i + 1 }
  const ids = [
    'stream-utils',
    'compress-lite',
    'log-helper',
    'color-text',
    'stream-utils'
  ]
  const project = phase === 2 ? 'tiny-tls' : ids[i % ids.length]!
  const source: Source = (['lisa', 'swarm', 'whale', 'rejected'] as const)[
    phase
  ]!
  const amount =
    phase === 2
      ? BUDGET_DEFAULTS.whaleContributionSats
      : BUDGET_DEFAULTS.contributionSats
  const event: Activity = {
    id: `demo-${i}`,
    project,
    source,
    sats: phase === 3 ? 0 : amount,
    dryRun: true,
    label:
      phase === 0
        ? 'Lisa’s agent'
        : phase === 2
          ? 'One large supporter'
          : phase === 3
            ? 'Unsigned agent'
            : `Agent ${String(i - 4).padStart(2, '0')}`,
    ...(phase === 3
      ? { reason: 'No valid owner signature. Excluded from matching.' }
      : {})
  }
  return {
    ...state,
    step: i + 1,
    feed: [event, ...state.feed].slice(0, 30),
    rejected: state.rejected + (phase === 3 ? 1 : 0),
    contributions:
      phase === 3
        ? state.contributions
        : [
            ...state.contributions,
            {
              project,
              owner:
                phase === 0 ? 'lisa' : phase === 2 ? 'whale' : `owner-${i}`,
              sats: amount
            }
          ]
  }
}
export function demoAt(step: number): DemoState {
  let state = emptyDemo()
  while (state.step < Math.min(step, DEMO_STEPS)) state = advanceDemo(state)
  return state
}
export function demoTally(state: DemoState): Tally {
  const rows = quadraticMatch(state.contributions, state.pool)
  return {
    round: 'round-1',
    pool: state.pool,
    rows,
    totalRaised: state.contributions.reduce((n, c) => n + c.sats, 0),
    totalMatched: rows.reduce((n, r) => n + r.match, 0),
    contributions: state.contributions.length,
    owners: new Set(state.contributions.map((c) => c.owner)).size,
    rejected: state.rejected,
    dryRun: true,
    dryRunContributions: state.contributions.length
  }
}
export function transactionUrl(event: Activity): string | null {
  return !event.dryRun &&
    event.source !== 'rejected' &&
    event.txid &&
    /^[a-f0-9]{64}$/i.test(event.txid)
    ? `https://whatsonchain.com/tx/${event.txid}`
    : null
}
