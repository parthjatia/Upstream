import { afterEach, describe, expect, it, vi } from 'vitest'
import { WERR_REVIEW_ACTIONS } from '@bsv/sdk'
import { describeWalletError, salvageTransaction, withWalletTap } from './walletErrors.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const walletResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

describe('withWalletTap', () => {
  it('captures the wallet response body the SDK discards', async () => {
    globalThis.fetch = vi.fn(
      async () => await Promise.resolve(walletResponse(400, '{"reason":"broadcast rejected"}'))
    ) as unknown as typeof fetch

    const { exchanges } = await withWalletTap(async () => {
      await fetch('http://localhost:3321/createAction')
      return 'done'
    })

    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]!.status).toBe(400)
    expect(exchanges[0]!.ok).toBe(false)
    expect(exchanges[0]!.body).toContain('broadcast rejected')
    expect(exchanges[0]!.call).toBe('createAction')
  })

  it('leaves the response readable by the caller', async () => {
    globalThis.fetch = vi.fn(
      async () => await Promise.resolve(walletResponse(200, '{"txid":"ab"}'))
    ) as unknown as typeof fetch

    const { result } = await withWalletTap(async () => {
      const res = await fetch('http://localhost:3321/createAction')
      return (await res.json()) as { txid: string }
    })
    // Tapping must clone, never consume.
    expect(result).toEqual({ txid: 'ab' })
  })

  it('ignores traffic that is not the wallet', async () => {
    globalThis.fetch = vi.fn(
      async () => await Promise.resolve(walletResponse(500, 'nope'))
    ) as unknown as typeof fetch

    const { exchanges } = await withWalletTap(async () => {
      await fetch('http://localhost:8787/funding')
      return null
    })
    expect(exchanges).toHaveLength(0)
  })

  it('captures the HTTPS wallet port too', async () => {
    globalThis.fetch = vi.fn(
      async () => await Promise.resolve(walletResponse(400, 'x'))
    ) as unknown as typeof fetch
    const { exchanges } = await withWalletTap(async () => {
      await fetch('https://localhost:2121/createAction')
      return null
    })
    expect(exchanges).toHaveLength(1)
  })

  it('restores fetch even when the call throws', async () => {
    const before = globalThis.fetch
    const { error } = await withWalletTap(async () => {
      throw new Error('boom')
    })
    expect((error as Error).message).toBe('boom')
    expect(globalThis.fetch).toBe(before)
  })

  it('returns the error instead of throwing it', async () => {
    const { result, error } = await withWalletTap(async () => {
      throw new Error('kaboom')
    })
    expect(result).toBeUndefined()
    expect((error as Error).message).toBe('kaboom')
  })
})

describe('describeWalletError', () => {
  it('includes the raw body for a bare HTTP status error', () => {
    // This is the exact shape the SDK throws when the 400 body is not a
    // decodable wallet-error envelope — the message alone says nothing.
    const err = new Error('HTTPWalletJSON createAction failed with HTTP status 400')
    const text = describeWalletError(err, [
      { call: 'createAction', status: 400, ok: false, body: '{"message":"fee too low"}' }
    ])
    expect(text).toContain('HTTP status 400')
    expect(text).toContain('fee too low')
    expect(text).toContain('--- wallet HTTP 400 on createAction ---')
  })

  it('unpacks the typed fields of a review error', () => {
    const err = new WERR_REVIEW_ACTIONS(
      [{ txid: 'a'.repeat(64), status: 'doubleSpend', competingTxs: ['b'.repeat(64)] }],
      [{ txid: 'a'.repeat(64), status: 'failed' }],
      'a'.repeat(64)
    )
    const text = describeWalletError(err, [])
    expect(text).toContain('reviewActionResults')
    expect(text).toContain('doubleSpend')
    expect(text).toContain('sendWithResults')
    expect(text).toContain('the wallet DID produce a transaction')
    expect(text).toContain('code:')
  })

  it('says so when no wallet exchange was captured', () => {
    expect(describeWalletError(new Error('x'), [])).toContain('no HTTP exchange')
  })

  it('reports a non-Error throw rather than swallowing it', () => {
    expect(describeWalletError({ weird: true }, [])).toContain('Non-error thrown')
  })

  it('prints unexpected custom fields', () => {
    const err = Object.assign(new Error('x'), { walletReason: 'insufficient fee' })
    expect(describeWalletError(err, [])).toContain('insufficient fee')
  })

  it('falls back to successful exchanges when none failed', () => {
    const text = describeWalletError(new Error('x'), [
      { call: 'createAction', status: 200, ok: true, body: '{"ok":1}' }
    ])
    expect(text).toContain('wallet HTTP 200')
  })
})

describe('salvageTransaction', () => {
  const txid = 'a'.repeat(64)

  it('recovers a number[] BEEF', () => {
    const got = salvageTransaction(new WERR_REVIEW_ACTIONS([], [], txid, [1, 2, 3]))
    expect(got).toEqual({ txid, tx: [1, 2, 3] })
  })

  it('recovers a Uint8Array BEEF', () => {
    // AtomicBEEF is `Byte[] | Uint8Array`; an Array.isArray-only check would
    // drop a real transaction here and risk funding the agents twice.
    const got = salvageTransaction(new WERR_REVIEW_ACTIONS([], [], txid, new Uint8Array([1, 2])))
    expect(got?.txid).toBe(txid)
    expect(got?.tx).toBeInstanceOf(Uint8Array)
  })

  it('returns null when there is no transaction to salvage', () => {
    expect(salvageTransaction(new Error('plain'))).toBeNull()
    expect(salvageTransaction(new WERR_REVIEW_ACTIONS([], [], txid))).toBeNull()
    expect(salvageTransaction({ txid: 'not-a-txid', tx: [1] })).toBeNull()
    expect(salvageTransaction(null)).toBeNull()
  })

  it('normalises the txid to lower case', () => {
    expect(salvageTransaction({ txid: 'A'.repeat(64), tx: [1] })?.txid).toBe(txid)
  })
})
