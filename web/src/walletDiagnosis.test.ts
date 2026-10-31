import { describe, expect, it } from 'vitest'
import { diagnoseWalletError } from './walletDiagnosis.ts'
import type { WalletExchange } from './walletErrors.ts'

/** The failure actually seen from BSV Desktop on the Lisa smoke test. */
const BEEF_MESSAGE =
  'WERR_INTERNAL: Storage method processAction failed: merged Beef failed validation'

const body = (json: string): WalletExchange[] => [
  { call: 'createAction', status: 400, ok: false, body: json }
]

describe('diagnoseWalletError', () => {
  it('recognises the merged BEEF failure and quotes it exactly', () => {
    const d = diagnoseWalletError(
      'HTTPWalletJSON createAction failed with HTTP status 400',
      body(`{"isError":true,"code":1,"message":"${BEEF_MESSAGE}"}`)
    )
    expect(d.exact).toBe(BEEF_MESSAGE)
    expect(d.title).toContain('could not validate the BEEF for its own funds')
    expect(d.side).toBe('wallet')
    expect(d.nothingSent).toBe(true)
    expect(d.meaning).toContain('processAction')
    expect(d.tryThis.length).toBeGreaterThan(2)
  })

  it('finds the message when it only appears in the error, not the body', () => {
    const d = diagnoseWalletError(`WERR_INTERNAL: ${BEEF_MESSAGE.split(': ').slice(1).join(': ')}`)
    expect(d.exact).toContain('merged Beef failed validation')
    expect(d.side).toBe('wallet')
  })

  it('finds the message when it only appears in the serialized detail', () => {
    const d = diagnoseWalletError('HTTPWalletJSON createAction failed with HTTP status 400', [], BEEF_MESSAGE)
    expect(d.title).toContain('BEEF')
    expect(d.side).toBe('wallet')
  })

  it('prefers the WERR line over a plainer JSON field', () => {
    const d = diagnoseWalletError(
      'something',
      body(`{"error":"bad request","message":"${BEEF_MESSAGE}"}`)
    )
    expect(d.exact).toBe(BEEF_MESSAGE)
  })

  it('un-escapes a JSON-escaped message', () => {
    const d = diagnoseWalletError('x', body('{"message":"WERR_INTERNAL: a \\"quoted\\" thing"}'))
    expect(d.exact).toContain('"quoted"')
  })

  it('falls back to other JSON keys when there is no WERR line', () => {
    expect(diagnoseWalletError('x', body('{"description":"fee too low"}')).exact).toBe('fee too low')
    expect(diagnoseWalletError('x', body('{"reason":"policy"}')).exact).toBe('policy')
  })

  it('recognises insufficient funds', () => {
    const d = diagnoseWalletError('WERR_INSUFFICIENT_FUNDS', [], '{"moreSatoshisNeeded":500}')
    expect(d.title).toContain('Not enough spendable')
    expect(d.nothingSent).toBe(true)
  })

  it('recognises a double spend and does NOT claim nothing was sent', () => {
    const d = diagnoseWalletError('x', [], '{"reviewActionResults":[{"status":"doubleSpend"}]}')
    expect(d.title).toContain('double spend')
    expect(d.nothingSent).toBe(false)
  })

  it('says so when a status came back with no captured body', () => {
    const d = diagnoseWalletError('HTTPWalletJSON createAction failed with HTTP status 400', [])
    expect(d.title).toContain('reason was not captured')
    expect(d.side).toBe('unknown')
  })

  it('still quotes the message for an unrecognised failure', () => {
    const d = diagnoseWalletError('something new went wrong', [])
    expect(d.exact).toBe('something new went wrong')
    expect(d.side).toBe('unknown')
    expect(d.nothingSent).toBe(false) // never claim safety we have not established
  })

  it('never returns an empty exact message', () => {
    for (const d of [
      diagnoseWalletError('x'),
      diagnoseWalletError('x', body('{}')),
      diagnoseWalletError('x', body('not json'))
    ]) {
      expect(d.exact.length).toBeGreaterThan(0)
    }
  })
})
