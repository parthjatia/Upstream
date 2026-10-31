import { describe, expect, it } from 'vitest'
import { quadraticMatch, type C } from './quadratic.ts'

/** `n` distinct owners giving `sats` each to `project`. */
const owners = (project: string, n: number, sats: number, tag: string): C[] =>
  Array.from({ length: n }, (_, i) => ({ project, owner: `${tag}-${i}`, sats }))

describe('quadraticMatch', () => {
  it('gives the crowd ~91,000 and the whale nothing (PROJECT_BRIEF.md Phase 2)', () => {
    const contribs: C[] = [
      ...owners('whale', 1, 50_000, 'w'), //  1 owner  × 50,000 = 50,000 raised
      ...owners('crowd', 500, 10, 'c'), // 500 owners ×     10 =  5,000 raised
      ...owners('medium', 50, 100, 'm') //  50 owners ×    100 =  5,000 raised
    ]

    const rows = quadraticMatch(contribs, 100_000)
    const by = (p: string) => rows.find(r => r.project === p)!

    // The whale raised 10x the crowd and gets zero match: one supporter means
    // (Σ√cᵢ)² === Σcᵢ, so there is no gap to subsidise.
    expect(by('whale').raised).toBe(50_000)
    expect(by('whale').supporters).toBe(1)
    expect(by('whale').gap).toBeCloseTo(0, 6)
    expect(by('whale').match).toBe(0)

    // Crowd and medium raised the same 5,000, but 500 supporters beat 50.
    expect(by('crowd').raised).toBe(5_000)
    expect(by('medium').raised).toBe(5_000)
    expect(by('crowd').match).toBeGreaterThan(by('medium').match)

    expect(by('crowd').match).toBeCloseTo(91_000, -3) // 91,058
    expect(by('medium').match).toBeCloseTo(9_000, -3) //  8,941

    // The pool is never overspent (each row floors).
    const paid = rows.reduce((a, r) => a + r.match, 0)
    expect(paid).toBeLessThanOrEqual(100_000)
    expect(paid).toBeGreaterThan(99_990)
  })

  it('counts owners, not transactions: an owner splitting a gift gains nothing', () => {
    const once = quadraticMatch(
      [
        { project: 'a', owner: 'o1', sats: 1_000 },
        { project: 'b', owner: 'x', sats: 1_000 }
      ],
      10_000
    )
    // Same owner, same 1,000 sats, now spread over 100 transactions.
    const split = quadraticMatch(
      [
        ...Array.from({ length: 100 }, () => ({ project: 'a', owner: 'o1', sats: 10 })),
        { project: 'b', owner: 'x', sats: 1_000 }
      ],
      10_000
    )
    const a = (rows: ReturnType<typeof quadraticMatch>) => rows.find(r => r.project === 'a')!
    expect(a(split).supporters).toBe(1)
    expect(a(split).raised).toBe(a(once).raised)
    expect(a(split).match).toBe(a(once).match)
  })

  it('is Sybil-resistant only per owner: 100 owners beat 1 owner at equal total', () => {
    const rows = quadraticMatch(
      [...owners('many', 100, 10, 'm'), ...owners('one', 1, 1_000, 'o')],
      10_000
    )
    const many = rows.find(r => r.project === 'many')!
    const one = rows.find(r => r.project === 'one')!
    expect(many.raised).toBe(one.raised)
    expect(many.match).toBe(10_000)
    expect(one.match).toBe(0)
  })

  // Known edge case in the specified algorithm, documented rather than patched:
  // `Math.sqrt(s) ** 2 - s` is not exactly 0 for every s (it is 5.68e-14 for
  // 500, but exactly 0 for 1,000 and 50,000). When EVERY project has a single
  // supporter, totalGap is nothing but that floating-point residue, and the
  // pool is divided by rounding noise instead of staying unpaid. It cannot
  // affect a round where any project has two or more supporters, because a real
  // gap is ~1e19 times larger than the residue.
  it('divides the pool by floating-point residue when every project has one supporter', () => {
    const rows = quadraticMatch([{ project: 'a', owner: 'o', sats: 500 }], 100_000)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.gap).toBeCloseTo(0, 6)
    expect(rows[0]!.gap).not.toBe(0) // residue, not a real gap
    expect(rows[0]!.match).toBe(100_000) // surprising, but harmless in a real round
  })

  it('pays nothing when the residue is exactly zero', () => {
    const rows = quadraticMatch([{ project: 'a', owner: 'o', sats: 1_000 }], 100_000)
    expect(rows[0]!.gap).toBe(0)
    expect(rows[0]!.match).toBe(0)
  })

  it('ignores the residue as soon as one project has real support', () => {
    const rows = quadraticMatch(
      [
        { project: 'whale', owner: 'w', sats: 50_000 },
        ...owners('crowd', 10, 10, 'c')
      ],
      100_000
    )
    expect(rows.find(r => r.project === 'whale')!.match).toBe(0)
    expect(rows.find(r => r.project === 'crowd')!.match).toBe(100_000)
  })

  it('returns no rows for no contributions', () => {
    expect(quadraticMatch([], 100_000)).toEqual([])
  })

  it('sums repeat gifts from the same owner before taking the root', () => {
    const rows = quadraticMatch(
      [
        { project: 'a', owner: 'o', sats: 40 },
        { project: 'a', owner: 'o', sats: 60 }
      ],
      1_000
    )
    expect(rows[0]!.raised).toBe(100)
    expect(rows[0]!.supporters).toBe(1)
    expect(rows[0]!.gap).toBeCloseTo(0, 6)
  })
})
