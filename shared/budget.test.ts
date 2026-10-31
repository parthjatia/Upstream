import { describe, expect, it } from 'vitest'
import {
  BUDGET_DEFAULTS,
  committedSats,
  fundingPlan,
  loadBudget,
  type Budget
} from './budget.ts'

/** The Budget table in PROJECT_BRIEF.md, as env would supply it. */
const BRIEF_ENV = {
  SWARM_SIZE: '50',
  SYBIL_SIZE: '10',
  FUND_LISA_SATS: '5000',
  FUND_SWARM_AGENT_SATS: '1500',
  FUND_WHALE_SATS: '20000',
  FUND_SYBIL_AGENT_SATS: '200',
  CONTRIBUTION_SATS: '10',
  WHALE_CONTRIBUTION_SATS: '19500',
  SPONSOR_POOL_SATS: '50000',
  TOTAL_BUDGET_SATS: '200000'
}

describe('budget', () => {
  it('matches the PROJECT_BRIEF.md table line for line', () => {
    const b = loadBudget(BRIEF_ENV)
    const plan = fundingPlan(b)

    expect(plan.lisa).toBe(5_000)
    expect(plan.swarm).toBe(75_000) // 50 x 1,500
    expect(plan.whale).toBe(20_000)
    expect(plan.sybil).toBe(2_000) //  10 x   200
    expect(plan.total).toBe(102_000)

    expect(b.sponsorPoolSats).toBe(50_000)
    expect(committedSats(b)).toBe(152_000)
    expect(b.totalBudgetSats - committedSats(b)).toBe(48_000) // buffer
  })

  it('funds 62 outputs in the Phase 3 transaction', () => {
    // 1 Lisa + 50 swarm + 1 whale + 10 sybil
    expect(fundingPlan(loadBudget(BRIEF_ENV)).outputs).toBe(62)
  })

  it('defaults to the brief when .env says nothing', () => {
    expect(loadBudget({})).toEqual(BUDGET_DEFAULTS)
    expect(loadBudget()).toEqual(BUDGET_DEFAULTS)
    expect(loadBudget(BRIEF_ENV)).toEqual(BUDGET_DEFAULTS)
  })

  it('ignores blank values rather than reading them as zero', () => {
    expect(loadBudget({ FUND_LISA_SATS: '' }).fundLisaSats).toBe(5_000)
    expect(loadBudget({ FUND_LISA_SATS: '   ' }).fundLisaSats).toBe(5_000)
  })

  it('lets .env override any amount', () => {
    const b = loadBudget({ ...BRIEF_ENV, CONTRIBUTION_SATS: '25', SWARM_SIZE: '3' })
    expect(b.contributionSats).toBe(25)
    expect(b.swarmSize).toBe(3)
    expect(fundingPlan(b).swarm).toBe(4_500)
  })

  it('refuses a budget that overspends the total', () => {
    expect(() =>
      loadBudget({ ...BRIEF_ENV, FUND_SWARM_AGENT_SATS: '3000' })
    ).toThrow(/Budget exceeded/)
    // 50 x 3,000 = 150,000 funding + 50,000 pool = 200,000... plus the rest.
    expect(() => loadBudget({ ...BRIEF_ENV, SWARM_SIZE: '200' })).toThrow(/over TOTAL_BUDGET_SATS/)
  })

  it('names the offending variable in the error', () => {
    expect(() => loadBudget({ FUND_LISA_SATS: '1,500' })).toThrow(/FUND_LISA_SATS="1,500"/)
    expect(() => loadBudget({ FUND_LISA_SATS: '1500.5' })).toThrow(/not a whole number/)
    expect(() => loadBudget({ FUND_LISA_SATS: '1e3' })).toThrow(/digits only/)
    expect(() => loadBudget({ FUND_LISA_SATS: '0' })).toThrow(/positive whole number/)
    expect(() => loadBudget({ FUND_LISA_SATS: 'abc' })).toThrow(/FUND_LISA_SATS/)
  })

  it('keeps the whale something back for its fee', () => {
    expect(() =>
      loadBudget({ ...BRIEF_ENV, WHALE_CONTRIBUTION_SATS: '20000' })
    ).toThrow(/must be below FUND_WHALE_SATS/)
    expect(() =>
      loadBudget({ ...BRIEF_ENV, WHALE_CONTRIBUTION_SATS: '25000' })
    ).toThrow(/cannot pay its fee/)
  })

  it('refuses to fund an agent too thinly to contribute once', () => {
    expect(() =>
      loadBudget({ ...BRIEF_ENV, FUND_SYBIL_AGENT_SATS: '10', CONTRIBUTION_SATS: '10' })
    ).toThrow(/FUND_SYBIL_AGENT_SATS=10 must exceed CONTRIBUTION_SATS=10/)
  })

  it('allows a deliberate budget increase', () => {
    const b: Budget = loadBudget({
      ...BRIEF_ENV,
      FUND_SWARM_AGENT_SATS: '3000',
      TOTAL_BUDGET_SATS: '400000'
    })
    expect(fundingPlan(b).swarm).toBe(150_000)
    expect(committedSats(b)).toBeLessThanOrEqual(b.totalBudgetSats)
  })
})
