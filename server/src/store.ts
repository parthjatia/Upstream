/**
 * `data/` — the server's record of what happened on chain.
 *
 * Gitignored: it holds mainnet transaction data for this particular round.
 *
 * The directory is resolved per call from `UPSTREAM_DATA_DIR`, defaulting to
 * `<repo>/data`. Tests point it at a temporary directory so running the suite
 * after a demo cannot overwrite a real round's records.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DATA_DIR as DEFAULT_DATA_DIR, ROOT } from '@upstream/shared/keystore'

export { ROOT }

export const dataDir = (): string => process.env.UPSTREAM_DATA_DIR ?? DEFAULT_DATA_DIR

export function ensureDataDir(): void {
  mkdirSync(dataDir(), { recursive: true })
}

export const dataPath = (...parts: string[]): string => join(dataDir(), ...parts)

/** Path as written into records: relative to the repo root, forward slashes. */
export const repoRelative = (absolute: string): string =>
  relative(ROOT, absolute).split(sep).join('/')

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(path: string, value: unknown): void {
  ensureDataDir()
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function writeText(path: string, value: string): void {
  ensureDataDir()
  writeFileSync(path, value, 'utf8')
}
