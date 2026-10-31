/**
 * Swarm timing, read from `.env` with CLI overrides.
 *
 *   SWARM_DURATION_SEC   how long the swarm runs (default 120)
 *   SWARM_DELAY_MS       pause between one agent's contributions: either a
 *                        range "500-2000" (uniform, the default) or a single
 *                        number for a fixed delay
 *
 * CLI flags win over `.env`, which is how `npm run swarm:demo` gets its short
 * run without needing cross-platform env syntax in package.json:
 *   --duration 60      --delay 500-2000
 */

export interface SwarmConfig {
  durationSec: number
  delayMinMs: number
  delayMaxMs: number
}

export const SWARM_DEFAULTS: SwarmConfig = {
  durationSec: 120,
  delayMinMs: 500,
  delayMaxMs: 2_000
}

type Env = Record<string, string | undefined>

function positiveInt(name: string, raw: string): number {
  const value = raw.trim()
  if (!/^\d+$/.test(value)) throw new Error(`${name}="${raw}" is not a whole number.`)
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name}="${raw}" must be positive.`)
  return n
}

export function parseDuration(raw: string | undefined, name = 'SWARM_DURATION_SEC'): number {
  if (raw === undefined || raw.trim() === '') return SWARM_DEFAULTS.durationSec
  return positiveInt(name, raw)
}

export function parseDelay(
  raw: string | undefined,
  name = 'SWARM_DELAY_MS'
): { delayMinMs: number; delayMaxMs: number } {
  if (raw === undefined || raw.trim() === '') {
    return { delayMinMs: SWARM_DEFAULTS.delayMinMs, delayMaxMs: SWARM_DEFAULTS.delayMaxMs }
  }
  const parts = raw.split('-')
  if (parts.length === 1) {
    const n = positiveInt(name, raw)
    return { delayMinMs: n, delayMaxMs: n }
  }
  if (parts.length !== 2) throw new Error(`${name}="${raw}" must be "<ms>" or "<min>-<max>".`)
  const min = positiveInt(name, parts[0]!)
  const max = positiveInt(name, parts[1]!)
  if (min > max) throw new Error(`${name}="${raw}": the minimum is above the maximum.`)
  return { delayMinMs: min, delayMaxMs: max }
}

/** Read `--flag value` or `--flag=value` from argv. */
export function argValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === `--${flag}`) return argv[i + 1]
    if (a.startsWith(`--${flag}=`)) return a.slice(flag.length + 3)
  }
  return undefined
}

export function loadSwarmConfig(env: Env = {}, argv: readonly string[] = []): SwarmConfig {
  const durationArg = argValue(argv, 'duration')
  const delayArg = argValue(argv, 'delay')
  return {
    durationSec:
      durationArg !== undefined
        ? parseDuration(durationArg, '--duration')
        : parseDuration(env.SWARM_DURATION_SEC),
    ...(delayArg !== undefined ? parseDelay(delayArg, '--delay') : parseDelay(env.SWARM_DELAY_MS))
  }
}

/** A delay drawn uniformly from the configured range. */
export const drawDelay = (c: SwarmConfig, rand: () => number = Math.random): number =>
  c.delayMinMs + Math.floor(rand() * (c.delayMaxMs - c.delayMinMs + 1))
