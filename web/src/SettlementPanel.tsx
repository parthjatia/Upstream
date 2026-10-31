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
import type {
  SettlementPreview,
  SettlementRecord
} from '../../server/src/settlement'
import {
  SETTLEMENT_LABEL,
  checkSettlementTx,
  resultsHash,
  settlementOutputs
} from '@upstream/shared/settlement'
import { call as apiCall } from './api'
import { WalletCallError, type Connection } from './wallet'
import {
  describeWalletError,
  salvageTransaction,
  withWalletTap
} from './walletErrors'

const BASE = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8787'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined
  })
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null
  if (!res.ok) throw new Error(body?.error ?? `${path}: HTTP ${res.status}`)
  return body as T
}

const getPreview = (): Promise<SettlementPreview> => call('/settlement/preview')

type PublicRecord = Omit<SettlementRecord, 'beefHex'>
const postSettlement = (body: {
  txid: string
  beefHex: string
  resultsJson: string
}) =>
  call<PublicRecord>('/settlement', {
    method: 'POST',
    body: JSON.stringify(body)
  })

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
    throw new Error(
      `results hash mismatch: server says ${preview.resultsHash}, the JSON hashes to ${hash}`
    )
  }
  const same =
    outputs.length === preview.outputs.length &&
    outputs.every(
      (o, i) =>
        o.lockingScript === preview.outputs[i]?.lockingScript &&
        o.satoshis === preview.outputs[i]?.satoshis
    )
  if (!same)
    throw new Error(
      'the server preview does not match the outputs derived from its results JSON'
    )

  const { result, error, exchanges } = await withWalletTap(
    async () =>
      await conn.wallet.createAction({
        description: `Upstream settlement ${preview.round}`.slice(0, 50),
        labels: [SETTLEMENT_LABEL],
        outputs: outputs.map((o) => ({
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
      salvage === null
        ? null
        : { txid: salvage.txid, beefHex: Utils.toHex(salvage.tx) },
      exchanges
    )
  }
  if (
    result?.sendWithResults?.some(
      (r) => r.txid === result.txid && r.status === 'failed'
    )
  ) {
    throw new WalletCallError(
      'The wallet reported a failed broadcast. Check BSV Desktop before retrying.',
      null,
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

export function SettlementPanel({
  conn,
  walletBusy = false
}: {
  conn: Connection | null
  walletBusy?: boolean
}) {
  const [preview, setPreview] = useState<SettlementPreview | null>(null)
  const [busy, setBusy] = useState<null | 'preview' | 'settle'>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [pool, setPool] = useState('')
  const [settled, setSettled] = useState<Settled | null>(null)

  const onPreview = async () => {
    setBusy('preview')
    setError(null)
    setDetail(null)
    try {
      const p = await getPreview()
      setPreview(p)
      setPool(String(p.pool))
      if (p.settled !== null)
        setSettled({ txid: p.settled.txid, recorded: true })
    } catch (e) {
      setPreview(null)
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
        setError(
          `Refusing to pay: the server runs ${p.network}, the wallet is on ${conn.network}.`
        )
        return
      }
      if (p.serverDryRun || p.dryRunContributions > 0) {
        setError(
          'Settlement requires a live round with no dry-run contributions.'
        )
        return
      }
      const projects = p.outputs.filter((o) => o.kind === 'project').length
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
          if (e.salvaged !== null) {
            setError(
              `The wallet produced ${e.salvaged.txid} before failing. Check BSV Desktop before retrying.`
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

  const canSettle =
    conn !== null &&
    !walletBusy &&
    busy === null &&
    settled === null &&
    preview !== null &&
    preview.settleable &&
    !preview.serverDryRun &&
    preview.dryRunContributions === 0

  const savePool = async () => {
    if (!/^\d+$/.test(pool) || !Number.isSafeInteger(Number(pool))) {
      setError('Enter a whole number of satoshis.')
      return
    }
    setBusy('preview')
    setError(null)
    try {
      await apiCall('/pledge', {
        method: 'POST',
        body: JSON.stringify({ pool: Number(pool) })
      })
      setPreview(await getPreview())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section>
      <div className="step-label">3 · Pay the matching pool</div>
      <h2>Review and settle</h2>
      <p className="muted">
        The backend splits the sponsor pool by quadratic funding. Review the
        allocation, then approve one payment to the projects in BSV Desktop.
      </p>
      <div className="controls">
        <button onClick={() => void onPreview()} disabled={busy !== null}>
          {busy === 'preview' ? 'Loading…' : 'Review matching'}
        </button>
        <button
          className="primary"
          onClick={() => void onSettle()}
          disabled={!canSettle}
        >
          {busy === 'settle'
            ? 'Review payment in BSV Desktop…'
            : preview
              ? `Pay ${sats(preview.totalSats)} sats in wallet`
              : 'Pay matching in wallet'}
        </button>
      </div>
      {preview && (
        <>
          <p className="muted">
            {sats(preview.pool)} sats pledged · {sats(preview.totalSats)} sats
            allocated · wallet fee added at approval.
          </p>
          {preview.reason && <p className="muted">{preview.reason}</p>}
          {(preview.serverDryRun || preview.dryRunContributions > 0) && (
            <p className="bad">
              A live round without dry-run contributions is required to settle.
            </p>
          )}
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="num">Matching payment</th>
                </tr>
              </thead>
              <tbody>
                {preview.results.rows.map((r) => (
                  <tr key={r.project}>
                    <td>{r.project}</td>
                    <td className="num">{sats(r.match)} sats</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>Adjust matching pool</summary>
            <p className="muted">
              A pledge sets the allocation. It does not move money.
            </p>
            <div className="controls">
              <input
                className="pool-input"
                aria-label="Matching pool in satoshis"
                inputMode="numeric"
                value={pool}
                onChange={(e) => setPool(e.target.value)}
              />
              <span>sats</span>
              <button
                onClick={() => void savePool()}
                disabled={busy !== null || settled !== null}
              >
                Save pledge
              </button>
            </div>
          </details>
          <details>
            <summary>Settlement proof</summary>
            <p className="mono small wrap">{preview.resultsHash}</p>
            <pre>{JSON.stringify(preview.results, null, 2)}</pre>
          </details>
        </>
      )}
      {settled && (
        <p className="ok">
          Payment broadcast
          {settled.recorded
            ? ' and recorded'
            : '; server record pending'} ·{' '}
          <a
            href={explorerTxUrl(settled.txid)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        </p>
      )}
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
      {detail && (
        <details>
          <summary>Wallet response</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </section>
  )
}
