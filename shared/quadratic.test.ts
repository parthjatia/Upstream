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
    expect(by('whale').gap).toBe(0)
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

  // Floating-point residue is floored away: `Math.sqrt(s) ** 2 - s` is 5.68e-14
  // for 500 sats and exactly 0 for 1,000, so without the guard a round where
  // every project has one supporter divided the pool by rounding noise.
  it('pays nothing when every project has a single supporter', () => {
    for (const amount of [10, 500, 1_000, 50_000, 123_457]) {
      const rows = quadraticMatch([{ project: 'a', owner: 'o', sats: amount }], 100_000)
      expect(rows, `${amount} sats`).toHaveLength(1)
      expect(rows[0]!.gap, `${amount} sats`).toBe(0)
      expect(rows[0]!.match, `${amount} sats`).toBe(0)
    }
  })

  it('pays nothing across several single-supporter projects', () => {
    const rows = quadraticMatch(
      [
        { project: 'a', owner: 'o1', sats: 500 },
        { project: 'b', owner: 'o2', sats: 500 },
        { project: 'c', owner: 'o3', sats: 20_000 }
      ],
      100_000
    )
    expect(rows.map(r => r.gap)).toEqual([0, 0, 0])
    expect(rows.reduce((a, r) => a + r.match, 0)).toBe(0)
  })

  it('never reports a negative gap', () => {
    const rows = quadraticMatch(
      Array.from({ length: 40 }, (_, i) => ({ project: `p${i}`, owner: 'o', sats: i + 1 })),
      100_000
    )
    for (const r of rows) expect(r.gap, r.project).toBeGreaterThanOrEqual(0)
  })

  it('still subsidises a genuine two-supporter gap, however small', () => {
    // Two owners of 1 sat each: gap = (1+1)^2 - 2 = 2, far above GAP_EPSILON.
    const rows = quadraticMatch(
      [
        { project: 'a', owner: 'o1', sats: 1 },
        { project: 'a', owner: 'o2', sats: 1 }
      ],
      100_000
    )
    expect(rows[0]!.gap).toBeCloseTo(2, 9)
    expect(rows[0]!.match).toBe(100_000)
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
