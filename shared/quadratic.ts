/**
 * Quadratic funding.
 *
 * A project's match is driven by the square of the sum of the square roots of
 * its contributions, not by the total raised. Splitting one big donation across
 * many independent owners therefore wins far more matching than giving it once,
 * which is exactly the property we want: usage becomes the vote.
 *
 * `gap` is the classic QF subsidy: (Σ√cᵢ)² − Σcᵢ. It is 0 for a project with a
 * single supporter however much they gave, so the whale earns no match at all.
 *
 * Contributions are keyed by OWNER, never by agent or transaction — one owner
 * running a hundred agents still counts once per project. That is the Sybil
 * defence; the server enforces it by verifying the owner's signature over the
 * agent's public key before a contribution ever reaches this function.
 *
 * This is the logic specified in PROJECT_BRIEF.md, with one guard added:
 * `Math.sqrt(s) ** 2 - s` is not exactly 0 for every s (it is 5.68e-14 for 500,
 * though exactly 0 for 1,000 and 50,000). Without a floor, a round in which
 * every project has a single supporter has a totalGap made purely of that
 * residue, and the pool gets divided by rounding noise. The smallest real gap
 * for two supporters of 1 sat each is 2, so GAP_EPSILON separates signal from
 * residue by many orders of magnitude.
 */

/** Gaps below this are floating-point residue, not real matching demand. */
export const GAP_EPSILON = 1e-6

/** One contribution: `owner` gave `sats` to `project`. */
export interface C {
  project: string
  owner: string
  sats: number
}

/** One row of the tally. `match` sums to at most `pool` (floored per row). */
export interface QuadraticRow {
  project: string
  raised: number
  supporters: number
  gap: number
  match: number
}

export function quadraticMatch(contribs: C[], pool: number): QuadraticRow[] {
  const byProject = new Map<string, Map<string, number>>()
  for (const c of contribs) {
    const owners = byProject.get(c.project) ?? new Map<string, number>()
    owners.set(c.owner, (owners.get(c.owner) ?? 0) + c.sats)
    byProject.set(c.project, owners)
  }
  const rows = [...byProject].map(([project, owners]) => {
    let sumSqrt = 0
    let raised = 0
    for (const s of owners.values()) {
      sumSqrt += Math.sqrt(s)
      raised += s
    }
    const raw = sumSqrt ** 2 - raised
    // Clamp at zero and discard residue, so a lone supporter reports gap 0.
    const gap = raw > GAP_EPSILON ? raw : 0
    return { project, raised, supporters: owners.size, gap }
  })
  const totalGap = rows.reduce((a, r) => a + r.gap, 0)
  return rows.map(r => ({
    ...r,
    match: totalGap > GAP_EPSILON ? Math.floor((r.gap / totalGap) * pool) : 0
  }))
}
