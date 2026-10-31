/**
 * Which tools a swarm agent uses, and how often.
 *
 * Quadratic funding counts SUPPORTERS (owners), not transactions. If every
 * agent picked from all five projects, each would end up with all fifty agents
 * as supporters and the match would split evenly — the opposite of the story.
 *
 * So each agent has a "stack", like a real program's dependencies: small,
 * ubiquitous libraries (stream-utils, compress-lite) are in almost every
 * stack, while the rest appear in fewer. Within its stack an agent then picks
 * by usage weight. The stack is derived from the agent's label, so a rerun
 * produces the same supporters.
 */
import { PROJECT_IDS } from '@upstream/shared/projects'

export interface ToolProfile {
  projectId: string
  /** Tool name, as Lisa's agent knows it. */
  tool: string
  /** Probability that an agent's stack includes this project. */
  adoption: number
  /** Relative call frequency once it is in the stack. */
  weight: number
}

export const TOOL_PROFILES: readonly ToolProfile[] = [
  { projectId: 'stream-utils', tool: 'formatDate', adoption: 0.9, weight: 5 },
  { projectId: 'compress-lite', tool: 'compressText', adoption: 0.85, weight: 5 },
  { projectId: 'color-text', tool: 'generatePalette', adoption: 0.35, weight: 2 },
  { projectId: 'log-helper', tool: 'spellCheck', adoption: 0.25, weight: 2 },
  { projectId: 'tiny-tls', tool: 'secureHash', adoption: 0.15, weight: 1 }
]

// Fail loudly if projects.json and this table drift apart.
for (const p of TOOL_PROFILES) {
  if (!PROJECT_IDS.includes(p.projectId)) {
    throw new Error(`swarm usage profile names unknown project "${p.projectId}"`)
  }
}

/** FNV-1a, for seeding. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: small, fast, seedable. Not for cryptography. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** The tools this agent depends on. Never empty. */
export function stackFor(agentLabel: string, profiles = TOOL_PROFILES): ToolProfile[] {
  const rand = seededRandom(hashString(`stack:${agentLabel}`))
  const stack = profiles.filter(p => rand() < p.adoption)
  if (stack.length > 0) return stack
  // Everyone uses at least the most common library.
  const top = [...profiles].sort((a, b) => b.adoption - a.adoption)[0]!
  return [top]
}

/** Pick one tool from a stack by weight. */
export function pickTool(stack: readonly ToolProfile[], rand: () => number = Math.random): ToolProfile {
  const total = stack.reduce((a, p) => a + p.weight, 0)
  let r = rand() * total
  for (const p of stack) {
    r -= p.weight
    if (r < 0) return p
  }
  return stack[stack.length - 1]!
}
