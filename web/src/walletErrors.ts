import type { AtomicBEEF } from '@bsv/sdk'

/**
 * Getting the real reason out of a failed wallet call.
 *
 * The SDK's HTTP substrate throws away the wallet's response body unless it
 * decodes as a structured error envelope: on any other 400 it raises a bare
 * `HTTPWalletJSON createAction failed with HTTP status 400`
 * (`HTTPWalletJSON.js`, the `if (!res.ok)` branch). That is why a failure can
 * look like a status code and nothing else.
 *
 * So we do two things: tap `fetch` to keep the raw request/response around for
 * the duration of a call, and serialize whatever the SDK did manage to throw,
 * including the typed fields on WERR_REVIEW_ACTIONS and WERR_INSUFFICIENT_FUNDS.
 */

/** One HTTP exchange with the wallet. */
export interface WalletExchange {
  call: string
  status: number
  ok: boolean
  body: string
}

/** BSV Desktop serves BRC-100 on 3321 (HTTP) and 2121 (HTTPS). */
const isWalletUrl = (url: string): boolean => /:(3321|2121)\b/.test(url)

const MAX_BODY = 4_000

/**
 * Run `fn` while recording every HTTP exchange with the wallet.
 *
 * The tap only reads clones, so it cannot disturb the SDK's own parsing, and it
 * is always removed again — including when `fn` throws.
 */
export async function withWalletTap<T>(
  fn: () => Promise<T>
): Promise<{ result: T | undefined; error: unknown; exchanges: WalletExchange[] }> {
  const exchanges: WalletExchange[] = []
  const original = globalThis.fetch

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const res = await original(input, init)
    if (isWalletUrl(url)) {
      let body = ''
      try {
        body = (await res.clone().text()).slice(0, MAX_BODY)
      } catch {
        body = '<unreadable>'
      }
      exchanges.push({
        call: url.split('/').pop() ?? url,
        status: res.status,
        ok: res.ok,
        body
      })
    }
    return res
  }

  try {
    return { result: await fn(), error: undefined, exchanges }
  } catch (error) {
    return { result: undefined, error, exchanges }
  } finally {
    globalThis.fetch = original
  }
}

/** A readable, complete account of a wallet failure. */
export function describeWalletError(error: unknown, exchanges: WalletExchange[] = []): string {
  const lines: string[] = []

  if (error instanceof Error) {
    lines.push(`${error.name}: ${error.message}`)
  } else {
    lines.push(`Non-error thrown: ${safeJson(error)}`)
  }

  const e = error as Record<string, unknown>

  // WERR_* errors carry typed fields the message does not mention.
  for (const key of ['code', 'isError', 'parameter', 'totalSatoshisNeeded', 'moreSatoshisNeeded']) {
    if (e?.[key] !== undefined) lines.push(`${key}: ${safeJson(e[key])}`)
  }

  // WERR_REVIEW_ACTIONS: thrown when acceptDelayedBroadcast is false and the
  // wallet signed but could not process the transaction. This is where a
  // broadcast rejection or a double spend actually shows up.
  if (Array.isArray(e?.reviewActionResults)) {
    lines.push(`reviewActionResults: ${safeJson(e.reviewActionResults)}`)
  }
  if (Array.isArray(e?.sendWithResults)) {
    lines.push(`sendWithResults: ${safeJson(e.sendWithResults)}`)
  }
  if (typeof e?.txid === 'string') {
    lines.push(`txid: ${e.txid}  (the wallet DID produce a transaction)`)
  }
  if (Array.isArray(e?.noSendChange) && e.noSendChange.length > 0) {
    lines.push(`noSendChange: ${safeJson(e.noSendChange)}`)
  }

  // Anything else the error carries that we have not already printed.
  const known = new Set([
    'code',
    'isError',
    'parameter',
    'totalSatoshisNeeded',
    'moreSatoshisNeeded',
    'reviewActionResults',
    'sendWithResults',
    'txid',
    'tx',
    'noSendChange',
    'stack',
    'message'
  ])
  for (const [key, value] of Object.entries(e ?? {})) {
    if (!known.has(key)) lines.push(`${key}: ${safeJson(value)}`)
  }

  // The raw bodies, which the SDK discarded.
  const failed = exchanges.filter(x => !x.ok)
  const shown = failed.length > 0 ? failed : exchanges
  for (const x of shown) {
    lines.push('')
    lines.push(`--- wallet HTTP ${x.status} on ${x.call} ---`)
    lines.push(x.body === '' ? '<empty body>' : x.body)
  }
  if (exchanges.length === 0) {
    lines.push('')
    lines.push('(no HTTP exchange with the wallet was captured — the call may have failed before it was sent)')
  }

  return lines.join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * If the wallet signed a transaction before failing, the error carries it.
 * Recovering it lets us record a transaction that really did go out, instead
 * of funding the same agents twice.
 */
export function salvageTransaction(error: unknown): { txid: string; tx: AtomicBEEF } | null {
  const e = error as Record<string, unknown>
  const txid = e?.txid
  const tx = e?.tx
  // AtomicBEEF is `Byte[] | Uint8Array`, so an Array.isArray check alone would
  // silently miss the Uint8Array case and lose a transaction that really exists.
  const isBeef = Array.isArray(tx) || tx instanceof Uint8Array
  if (typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid) && isBeef) {
    return { txid: txid.toLowerCase(), tx: tx as AtomicBEEF }
  }
  return null
}
