/**
 * Runtime switches that are not satoshi amounts.
 *
 * DRY_RUN is the important one. In dry-run the agents do everything except
 * broadcast: they build real transactions, pay a real fee, sign with their real
 * keys and check the result with the SDK — then stop. Going live is setting
 * DRY_RUN=false, with no code path that only exists in one mode.
 */

export interface Runtime {
  /** True when transactions are built and signed but never broadcast. */
  dryRun: boolean
  /** Port the tally server listens on (PORT). */
  port: number
  /** Arcade base URL, used for broadcasting and headers. */
  arcadeUrl: string
  /** Explorer base for the links printed in logs and the UI. */
  explorerTxUrl: string
  /** Network the whole demo runs on. */
  network: string
  /** Current funding round. */
  round: string
  /**
   * Where agents report contributions (SERVER_URL). Defaults to localhost on
   * `port`, so setting PORT alone is enough for a local run.
   */
  serverUrl: string
}

/** The port used when PORT is unset. */
export const DEFAULT_PORT = 8787

export const ARCADE_MAINNET = 'https://arcade-v2-us-1.bsvblockchain.tech'
export const EXPLORER_MAINNET = 'https://whatsonchain.com/tx/'

/**
 * Read a boolean env var. Anything but an explicit false-ish value is true for
 * DRY_RUN, so a typo keeps us safe rather than broadcasting by accident.
 */
export function readDryRun(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(value)) return false
  if (['true', '1', 'yes', 'on', ''].includes(value)) return true
  throw new Error(`DRY_RUN="${raw}" is not a boolean (use true or false).`)
}

/** Parse PORT, refusing anything that is not a usable TCP port. */
export function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT
  const value = raw.trim()
  if (!/^\d+$/.test(value)) {
    throw new Error(`PORT="${raw}" is not a number.`)
  }
  const port = Number(value)
  if (port < 1 || port > 65_535) {
    throw new Error(`PORT=${port} is outside the valid range 1-65535.`)
  }
  return port
}

type Env = Record<string, string | undefined>

export function loadRuntime(env: Env = {}): Runtime {
  const port = readPort(env.PORT)
  const serverUrl = (env.SERVER_URL ?? `http://localhost:${port}`).replace(/\/$/, '')
  return {
    dryRun: readDryRun(env.DRY_RUN),
    port,
    arcadeUrl: (env.ARCADE_URL ?? ARCADE_MAINNET).replace(/\/$/, ''),
    explorerTxUrl: env.EXPLORER_TX_URL ?? EXPLORER_MAINNET,
    network: env.BSV_NETWORK ?? 'mainnet',
    round: env.ROUND ?? 'round-1',
    serverUrl
  }
}

/** One line describing the mode, printed by every agent script. */
export const describeMode = (r: Runtime): string =>
  r.dryRun
    ? `DRY RUN — transactions are built, signed and checked, but NOT broadcast (${r.network})`
    : `LIVE — transactions will be broadcast to ${r.arcadeUrl} (${r.network}). Real satoshis.`
