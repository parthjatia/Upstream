/**
 * Phase 9 — settle the round from the sponsor's BSV Desktop.
 *
 * "Preview settlement" asks the server for the round results and shows what
 * would be paid. "Settle round" does NOT sign what the server sent: it
 * re-derives every output from the results JSON and the project registry
 * (`settlementOutputs`, shared with the server), checks the hash, and only then
 * hands the outputs to ONE `createAction` — exactly the Appendix A shape for an
 * indexed payment (`randomizeOutputs: false`, `acceptDelayedBroadcast: false`).
 * The pool leaves the sponsor's own wallet; no key is ever asked for.
 */
import { useState } from 'react'
import { Transaction, Utils } from '@bsv/sdk'
import { explorerTxUrl } from '@upstream/shared/funding'
import { sats } from '@upstream/shared/budget'
import type { SettlementPreview, SettlementRecord } from '../../server/src/settlement'
import {
  SETTLEMENT_LABEL,
  checkSettlementTx,
  resultsHash,
  settlementOutputs
} from '@upstream/shared/settlement'
import { WalletCallError, type Connection } from './wallet'
import { describeWalletError, salvageTransaction, withWalletTap } from './walletErrors'

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8787'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined
  })
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error ?? `${path}: HTTP ${res.status}`)
  return body as T
}

const getPreview = (): Promise<SettlementPreview> => call('/settlement/preview')

type PublicRecord = Omit<SettlementRecord, 'beefHex'>
const postSettlement = (body: { txid: string; beefHex: string; resultsJson: string }) =>
  call<PublicRecord>('/settlement', { method: 'POST', body: JSON.stringify(body) })

interface Settled {
  txid: string
  recorded: boolean
}

/**
 * ONE createAction paying every matched project plus the results-hash OP_RETURN.
 * Outputs are rebuilt here from the results JSON; the server's copy is only
 * used to cross-check.
 */
async function settleWithWallet(
  conn: Connection,
  preview: SettlementPreview
): Promise<{ txid: string; beefHex: string }> {
  const outputs = settlementOutputs(preview.resultsJson)
  const hash = resultsHash(preview.resultsJson)
  if (hash !== preview.resultsHash) {
    throw new Error(`results hash mismatch: server says ${preview.resultsHash}, the JSON hashes to ${hash}`)
  }
  const same =
    outputs.length === preview.outputs.length &&
    outputs.every(
      (o, i) =>
        o.lockingScript === preview.outputs[i]?.lockingScript &&
        o.satoshis === preview.outputs[i]?.satoshis
    )
  if (!same) throw new Error('the server preview does not match the outputs derived from its results JSON')

  const { result, error, exchanges } = await withWalletTap(
    async () =>
      await conn.wallet.createAction({
        description: `Upstream settlement ${preview.round}`.slice(0, 50),
        labels: [SETTLEMENT_LABEL],
        outputs: outputs.map(o => ({
          lockingScript: o.lockingScript,
          satoshis: o.satoshis,
          outputDescription: o.outputDescription
        })),
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
  )

  if (error !== undefined) {
    const salvage = salvageTransaction(error)
    throw new WalletCallError(
      describeWalletError(error, exchanges),
      salvage === null ? null : { txid: salvage.txid, beefHex: Utils.toHex(salvage.tx) },
      exchanges
    )
  }
  if (!result?.txid || !result.tx) {
    throw new WalletCallError(
      `The wallet returned no transaction.\nresult: ${JSON.stringify(result)}`,
      null,
      exchanges
    )
  }

  // Outputs found by locking script, never by index (guide §6.1).
  checkSettlementTx(Transaction.fromAtomicBEEF(result.tx), preview.resultsJson)
  return { txid: result.txid, beefHex: Utils.toHex(result.tx) }
}

export function SettlementPanel({ conn }: { conn: Connection | null }) {
  const [preview, setPreview] = useState<SettlementPreview | null>(null)
  const [busy, setBusy] = useState<null | 'preview' | 'settle'>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [ackDryRun, setAckDryRun] = useState(false)
  const [settled, setSettled] = useState<Settled | null>(null)

  const onPreview = async () => {
    setBusy('preview')
    setError(null)
    setDetail(null)
    try {
      const p = await getPreview()
      setPreview(p)
      setAckDryRun(false)
      if (p.settled !== null) setSettled({ txid: p.settled.txid, recorded: true })
    } catch (e) {
      setError(`Could not load the preview: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const onSettle = async () => {
    if (!conn) return
    setBusy('settle')
    setError(null)
    setDetail(null)
    try {
      // Always settle against a fresh tally, never a stale screen.
      const p = await getPreview()
      setPreview(p)
      if (!p.settleable) {
        setError(`Nothing to settle: ${p.reason ?? 'unknown reason'}`)
        return
      }
      if (p.network !== conn.network) {
        setError(`Refusing to pay: the server runs ${p.network}, the wallet is on ${conn.network}.`)
        return
      }
      if (p.dryRunContributions > 0 && !ackDryRun) {
        setError('This tally includes dry-run contributions. Tick the box to settle anyway.')
        return
      }
      const projects = p.outputs.filter(o => o.kind === 'project').length
      const ok = window.confirm(
        `Pay ${sats(p.totalSats)} sats of matching to ${projects} project(s) from this wallet, ` +
          `plus an OP_RETURN with the results hash ${p.resultsHash.slice(0, 16)}…?\n\n` +
          `This is ${p.network.toUpperCase()}. The satoshis are real.` +
          (p.warnings.length > 0 ? `\n\n${p.warnings.join('\n')}` : '')
      )
      if (!ok) return

      let tx: { txid: string; beefHex: string }
      try {
        tx = await settleWithWallet(conn, p)
      } catch (e) {
        if (e instanceof WalletCallError) {
          setDetail(e.detail)
          // The wallet may have signed before failing; record it so a retry
          // cannot pay the pool twice.
          if (e.salvaged !== null) {
            setSettled({ txid: e.salvaged.txid, recorded: false })
            try {
              await postSettlement({ ...e.salvaged, resultsJson: p.resultsJson })
              setSettled({ txid: e.salvaged.txid, recorded: true })
            } catch {
              /* shown below via the error */
            }
            setError(
              `The wallet produced ${e.salvaged.txid} before failing. Check the explorer before retrying.`
            )
            return
          }
        }
        throw e
      }

      setSettled({ txid: tx.txid, recorded: false })
      await postSettlement({ ...tx, resultsJson: p.resultsJson })
      setSettled({ txid: tx.txid, recorded: true })
      void getPreview().then(setPreview)
    } catch (e) {
      setError(`Settlement failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const matched = preview?.outputs.filter(o => o.kind === 'project') ?? []
  const maxMatch = Math.max(1, ...matched.map(o => o.satoshis))
  const needsAck = (preview?.dryRunContributions ?? 0) > 0
  const canSettle =
    conn !== null &&
    busy === null &&
    preview !== null &&
    preview.settleable &&
    (!needsAck || ackDryRun)

  return (
    <section>
      <h2>6 · Settle the round</h2>
      <p className="muted">
        The sponsor pays every project its quadratic match from this wallet in one transaction,
        with the SHA-256 of the round results in an OP_RETURN so anyone can audit the split.
      </p>

      <button onClick={() => void onPreview()} disabled={busy !== null}>
        {busy === 'preview' ? 'Loading…' : 'Preview settlement'}
      </button>{' '}
      <button className="primary" onClick={() => void onSettle()} disabled={!canSettle}>
        {busy === 'settle' ? 'Waiting for the wallet…' : 'Settle round'}
      </button>
      {conn === null && <p className="muted small">Connect BSV Desktop to settle.</p>}

      {preview !== null && (
        <div style={{ marginTop: '1rem' }}>
          <dl>
            <dt>Round</dt>
            <dd>
              {preview.round} · {preview.network}
            </dd>
            <dt>Pool</dt>
            <dd>{sats(preview.pool)} sats</dd>
            <dt>Paid out</dt>
            <dd>
              {sats(preview.totalSats)} sats to {matched.length} project(s)
            </dd>
            <dt>Results hash</dt>
            <dd className="mono small wrap">{preview.resultsHash}</dd>
          </dl>

          {preview.reason !== null && <p className="bad">{preview.reason}</p>}
          {preview.warnings.map(w => (
            <p key={w} className="bad small">
              {w}
            </p>
          ))}
          {needsAck && preview.settleable && (
            <label className="small">
              <input
                type="checkbox"
                checked={ackDryRun}
                onChange={e => setAckDryRun(e.target.checked)}
              />{' '}
              I understand {preview.dryRunContributions} contribution(s) were never broadcast, and
              still want to pay real matching.
            </label>
          )}

          <div className="scroll" style={{ marginTop: '0.75rem' }}>
            <table>
              <thead>
                <tr>
                  <th>Output</th>
                  <th>Project</th>
                  <th className="num">Supporters</th>
                  <th className="num">Raised</th>
                  <th className="num">Match</th>
                  <th style={{ width: '30%' }} />
                </tr>
              </thead>
              <tbody>
                {preview.results.rows.map(r => {
                  const i = preview.outputs.findIndex(o => o.project === r.project)
                  return (
                    <tr key={r.project}>
                      <td className="mono">{i >= 0 ? `#${i}` : '—'}</td>
                      <td>{r.project}</td>
                      <td className="num">{r.supporters}</td>
                      <td className="num">{sats(r.raised)}</td>
                      <td className="num">{sats(r.match)}</td>
                      <td>
                        <div
                          className={settled !== null ? 'settle-bar settle-bar-paid' : 'settle-bar'}
                          style={{
                            height: '0.5rem',
                            borderRadius: '0.25rem',
                            background: 'var(--accent)',
                            width: `${(r.match / maxMatch) * 100}%`,
                            opacity: settled !== null ? 1 : 0.45,
                            transition: 'width 900ms ease-out, opacity 900ms'
                          }}
                        />
                      </td>
                    </tr>
                  )
                })}
                <tr>
                  <td className="mono">#{preview.outputs.length - 1}</td>
                  <td colSpan={5} className="small muted">
                    OP_RETURN · UPSTREAM-SETTLE · {preview.round} · sha256
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <details>
            <summary>Round results JSON (hashed on chain)</summary>
            <pre>{JSON.stringify(JSON.parse(preview.resultsJson), null, 2)}</pre>
          </details>
        </div>
      )}

      {settled !== null && (
        <p className="ok">
          Settled{settled.recorded ? '' : ' (not yet recorded by the server)'}:{' '}
          <a href={explorerTxUrl(settled.txid)} target="_blank" rel="noreferrer">
            {settled.txid}
          </a>
        </p>
      )}
      {error !== null && <p className="bad">{error}</p>}
      {detail !== null && (
        <details>
          <summary>Full wallet response</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </section>
  )
}
