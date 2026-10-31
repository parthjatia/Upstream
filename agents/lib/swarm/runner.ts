/**
 * The swarm loop: many agents, in parallel, each paying for the tools it uses.
 *
 * Each agent loops until the deadline (or until it runs out of money): pick a
 * tool from its stack, `contribute()`, wait a random delay. The contribution
 * function is injected so the loop can be tested without a server.
 */
import { PrivateKey } from '@bsv/sdk'
import type { AgentAttestation } from '@upstream/shared/attestation'
import type { Budget } from '@upstream/shared/budget'
import type { Runtime } from '@upstream/shared/runtime'
import {
  contribute as realContribute,
  ContributeError,
  type ContributionRequest,
  type ContributionResult
} from '../contribute.ts'
import { drawDelay, type SwarmConfig } from './config.ts'
import { sleep } from './server.ts'
import { pickTool, stackFor, type ToolProfile } from './usage.ts'

export interface SwarmAgent {
  label: string
  key: PrivateKey
  attestation: AgentAttestation
}

export type ContributeFn = (
  req: ContributionRequest,
  opts: { budget: Budget; runtime: Runtime }
) => Promise<ContributionResult>

export type SwarmEvent =
  | { kind: 'paid'; agent: string; tool: ToolProfile; result: ContributionResult }
  | { kind: 'retired'; agent: string; reason: string }
  | { kind: 'error'; agent: string; message: string }

export interface ProjectStats {
  txs: number
  accepted: number
  sats: number
  /** Agents with at least one accepted contribution. */
  supporters: Set<string>
}

export interface SwarmStats {
  txs: number
  accepted: number
  rejected: number
  fees: number
  errors: number
  retired: number
  byProject: Map<string, ProjectStats>
  elapsedMs: number
}

export interface RunSwarmOptions {
  agents: SwarmAgent[]
  config: SwarmConfig
  budget: Budget
  runtime: Runtime
  contribute?: ContributeFn
  signal?: AbortSignal
  onEvent?: (e: SwarmEvent) => void
  rand?: () => number
  /** Stop an agent after this many consecutive unexpected errors. */
  maxConsecutiveErrors?: number
}

export async function runSwarm(opts: RunSwarmOptions): Promise<SwarmStats> {
  const contribute = opts.contribute ?? realContribute
  const rand = opts.rand ?? Math.random
  const maxErrors = opts.maxConsecutiveErrors ?? 5
  const started = Date.now()
  const deadline = started + opts.config.durationSec * 1_000

  const stats: SwarmStats = {
    txs: 0,
    accepted: 0,
    rejected: 0,
    fees: 0,
    errors: 0,
    retired: 0,
    byProject: new Map(),
    elapsedMs: 0
  }
  const projectStats = (id: string): ProjectStats => {
    let s = stats.byProject.get(id)
    if (s === undefined) {
      s = { txs: 0, accepted: 0, sats: 0, supporters: new Set() }
      stats.byProject.set(id, s)
    }
    return s
  }

  const stopped = (): boolean => opts.signal?.aborted === true || Date.now() >= deadline

  async function agentLoop(agent: SwarmAgent): Promise<void> {
    const stack = stackFor(agent.label)
    // Stagger the start so fifty agents do not all fire on the same tick.
    await sleep(Math.floor(rand() * opts.config.delayMaxMs), opts.signal)

    let consecutiveErrors = 0
    while (!stopped()) {
      const tool = pickTool(stack, rand)
      try {
        const result = await contribute(
          {
            agentLabel: agent.label,
            agentKey: agent.key,
            projectId: tool.projectId,
            attestation: agent.attestation
          },
          { budget: opts.budget, runtime: opts.runtime }
        )
        consecutiveErrors = 0
        stats.txs++
        stats.fees += result.fee
        const ps = projectStats(tool.projectId)
        ps.txs++
        if (result.accepted) {
          stats.accepted++
          ps.accepted++
          ps.sats += result.sats
          ps.supporters.add(agent.label)
        } else {
          stats.rejected++
        }
        opts.onEvent?.({ kind: 'paid', agent: agent.label, tool, result })
      } catch (err) {
        const message = (err as Error).message
        // Out of money (or never funded) is the natural end of an agent.
        if (err instanceof ContributeError && /not enough|no spendable output/.test(message)) {
          stats.retired++
          opts.onEvent?.({ kind: 'retired', agent: agent.label, reason: message })
          return
        }
        stats.errors++
        consecutiveErrors++
        opts.onEvent?.({ kind: 'error', agent: agent.label, message })
        if (consecutiveErrors >= maxErrors) {
          stats.retired++
          opts.onEvent?.({
            kind: 'retired',
            agent: agent.label,
            reason: `${maxErrors} errors in a row, last: ${message}`
          })
          return
        }
      }
      await sleep(drawDelay(opts.config, rand), opts.signal)
    }
  }

  await Promise.all(opts.agents.map(agentLoop))
  stats.elapsedMs = Date.now() - started
  return stats
}
