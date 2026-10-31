/**
 * The budget: every satoshi amount and agent count, read from `.env`.
 *
 * Mainnet, real money. No amount is hard-coded anywhere else in the codebase —
 * see the Budget table in PROJECT_BRIEF.md.
 *
 * `loadBudget` takes an env record rather than reading `process.env` itself, so
 * the browser can use the same code on a budget the server hands it over HTTP
 * (the web app must not read `.env`, and cannot read `keys/` at all).
 */

export interface Budget {
  /** Number of swarm agents, each with its own distinct owner. */
  swarmSize: number
  /** Number of unvouched attacker agents. */
  sybilSize: number

  /** Phase 3, per agent, in one funding transaction from BSV Desktop. */
  fundLisaSats: number
  fundSwarmAgentSats: number
  fundWhaleSats: number
  fundSybilAgentSats: number

  /** What an agent pays a project per tool call. */
  contributionSats: number
  /** The whale's single large payment. */
  whaleContributionSats: number

  /** The sponsor's matching pool; stays in the wallet until settlement. */
  sponsorPoolSats: number
  /** Hard ceiling on funding + pool. */
  totalBudgetSats: number
}

/** The Budget table from PROJECT_BRIEF.md, used when `.env` is silent. */
export const BUDGET_DEFAULTS: Budget = {
  swarmSize: 50,
  sybilSize: 10,
  fundLisaSats: 5_000,
  fundSwarmAgentSats: 1_500,
  fundWhaleSats: 20_000,
  fundSybilAgentSats: 200,
  contributionSats: 10,
  whaleContributionSats: 19_500,
  sponsorPoolSats: 50_000,
  totalBudgetSats: 200_000
}

/** Env var name for each field, so errors can name the variable to fix. */
const ENV_KEYS: Record<keyof Budget, string> = {
  swarmSize: 'SWARM_SIZE',
  sybilSize: 'SYBIL_SIZE',
  fundLisaSats: 'FUND_LISA_SATS',
  fundSwarmAgentSats: 'FUND_SWARM_AGENT_SATS',
  fundWhaleSats: 'FUND_WHALE_SATS',
  fundSybilAgentSats: 'FUND_SYBIL_AGENT_SATS',
  contributionSats: 'CONTRIBUTION_SATS',
  whaleContributionSats: 'WHALE_CONTRIBUTION_SATS',
  sponsorPoolSats: 'SPONSOR_POOL_SATS',
  totalBudgetSats: 'TOTAL_BUDGET_SATS'
}

/** What the Phase 3 funding transaction spends, broken down. */
export interface FundingPlan {
  lisa: number
  swarm: number
  whale: number
  sybil: number
  /** Sum of all funding outputs. */
  total: number
  /** Number of outputs in the funding transaction. */
  outputs: number
}

export function fundingPlan(b: Budget): FundingPlan {
  const lisa = b.fundLisaSats
  const swarm = b.fundSwarmAgentSats * b.swarmSize
  const whale = b.fundWhaleSats
  const sybil = b.fundSybilAgentSats * b.sybilSize
  return {
    lisa,
    swarm,
    whale,
    sybil,
    total: lisa + swarm + whale + sybil,
    // 1 Lisa + swarmSize + 1 whale + sybilSize
    outputs: 2 + b.swarmSize + b.sybilSize
  }
}

/** Funding + pool. What the demo actually commits of the 200,000. */
export const committedSats = (b: Budget): number => fundingPlan(b).total + b.sponsorPoolSats

/** Group digits the same way everywhere, regardless of the host locale. */
export const sats = (n: number): string => n.toLocaleString('en-US')

type Env = Record<string, string | undefined>

function readInt(env: Env, field: keyof Budget): number {
  const name = ENV_KEYS[field]
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return BUDGET_DEFAULTS[field]
  // Reject "1,500", "1500.5", "1e3" and other things that silently truncate.
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name}="${raw}" is not a whole number of satoshis (digits only, no commas).`)
  }
  const n = Number(raw.trim())
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name}="${raw}" must be a positive whole number.`)
  }
  return n
}

/**
 * Build a validated budget. Throws with an actionable message rather than
 * letting a typo turn into a mainnet transaction for the wrong amount.
 */
export function loadBudget(env: Env = {}): Budget {
  const b = Object.fromEntries(
    (Object.keys(ENV_KEYS) as Array<keyof Budget>).map(f => [f, readInt(env, f)])
  ) as unknown as Budget

  const plan = fundingPlan(b)
  const committed = committedSats(b)

  if (committed > b.totalBudgetSats) {
    throw new Error(
      `Budget exceeded: funding ${sats(plan.total)} + pool ` +
        `${sats(b.sponsorPoolSats)} = ${sats(committed)} sats, ` +
        `over ${ENV_KEYS.totalBudgetSats}=${sats(b.totalBudgetSats)}. ` +
        `Lower the funding amounts or raise ${ENV_KEYS.totalBudgetSats} deliberately.`
    )
  }

  // The whale must keep something back for the fee on its own transaction.
  if (b.whaleContributionSats >= b.fundWhaleSats) {
    throw new Error(
      `${ENV_KEYS.whaleContributionSats}=${b.whaleContributionSats} must be below ` +
        `${ENV_KEYS.fundWhaleSats}=${b.fundWhaleSats}, or the whale cannot pay its fee.`
    )
  }

  // Likewise every ordinary agent needs more than one contribution's worth.
  for (const [fund, label] of [
    [b.fundLisaSats, ENV_KEYS.fundLisaSats],
    [b.fundSwarmAgentSats, ENV_KEYS.fundSwarmAgentSats],
    [b.fundSybilAgentSats, ENV_KEYS.fundSybilAgentSats]
  ] as const) {
    if (fund <= b.contributionSats) {
      throw new Error(
        `${label}=${fund} must exceed ${ENV_KEYS.contributionSats}=${b.contributionSats}, ` +
          `or the agent cannot make a single contribution and pay a fee.`
      )
    }
  }

  return b
}

/** Human-readable budget summary for script output. */
export function describeBudget(b: Budget): string {
  const plan = fundingPlan(b)
  const row = (label: string, amount: number): string =>
    `  ${label.padEnd(38)}${sats(amount).padStart(9)}`
  const rule = (label: string, note: string): string => `  ${'-'.repeat(38)}${label} ${note}`

  return [
    row("Lisa's agent", plan.lisa),
    row(`Swarm: ${b.swarmSize} agents x ${sats(b.fundSwarmAgentSats)}`, plan.swarm),
    row('Whale (one payment)', plan.whale),
    row(`Attacker: ${b.sybilSize} agents x ${sats(b.fundSybilAgentSats)}`, plan.sybil),
    rule(' funding tx:', `${sats(plan.total)} over ${plan.outputs} outputs`),
    row('Sponsor pool (stays in wallet)', b.sponsorPoolSats),
    rule(' committed: ', `${sats(committedSats(b))} of ${sats(b.totalBudgetSats)}`),
    row('Buffer for fees and retries', b.totalBudgetSats - committedSats(b))
  ].join('\n')
}
