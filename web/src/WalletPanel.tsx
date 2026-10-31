/**
 * Phase 3 — fund the agents from BSV Desktop.
 *
 * Mainnet, real money, so the order is deliberate: connect, check the wallet
 * for unfinished actions, smoke-test with Lisa alone, then the full fan-out
 * behind a confirmation that names the total. All signing happens in BSV
 * Desktop; this page never asks for a key.
 */
import { useCallback, useEffect, useState } from 'react'
import type { WalletAction } from '@bsv/sdk'
import {
  explorerTxUrl,
  type FundingPlanResponse,
  type FundingRecord,
  type FundingScope
} from '@upstream/shared/funding'
import { sats } from '@upstream/shared/budget'
import {
  getFundingPlan,
  getHealth,
  getLisaAgent,
  postAttestation,
  postFunding,
  type Health,
  type LisaAgent
} from './api'
import { diagnoseWalletError, type Diagnosis } from './walletDiagnosis'
import {
  WalletCallError,
  attestAgent,
  connect,
  fundAgents,
  listFundingActions,
  spendableBalance,
  type Connection
} from './wallet'
import { PaymentPanel } from './PaymentPanel'
import { SettlementPanel } from './SettlementPanel'
import './wallet.css'

type Busy = null | 'connect' | 'lisa' | 'all' | 'attest' | 'actions'

interface LogLine {
  text: string
  txid?: string
  bad?: boolean
  detail?: string
  diagnosis?: Diagnosis
}

export function WalletPanel({
  stage,
  settled = false
}: {
  stage: 'fund' | 'pay' | 'settle' | null
  settled?: boolean
}) {
  const [plan, setPlan] = useState<FundingPlanResponse | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [conn, setConn] = useState<Connection | null>(null)
  const [lisa, setLisa] = useState<LisaAgent | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [funded, setFunded] = useState<FundingRecord[]>([])
  const [actions, setActions] = useState<WalletAction[] | null>(null)

  const say = useCallback((text: string, opts: Omit<LogLine, 'text'> = {}) => {
    setLog((l) => [{ text, ...opts }, ...l])
  }, [])

  /** Log a wallet failure with everything we could recover about it. */
  const sayFailure = useCallback(
    (what: string, e: unknown) => {
      if (e instanceof WalletCallError) {
        console.error(`${what}\n${e.detail}`)
        say(what, {
          bad: true,
          detail: e.detail,
          diagnosis: diagnoseWalletError(e.message, e.exchanges, e.detail)
        })
      } else {
        const msg = (e as Error).message
        console.error(what, e)
        say(`${what}: ${msg}`, {
          bad: true,
          detail: String((e as Error).stack ?? msg)
        })
      }
    },
    [say]
  )

  const refreshServer = useCallback(() => {
    void Promise.all([getHealth(), getFundingPlan('all'), getLisaAgent()])
      .then(([h, p, a]) => {
        setHealth(h)
        setPlan(p)
        setLisa(a)
        setServerError(null)
      })
      .catch((e) => {
        setHealth(null)
        setPlan(null)
        setLisa(null)
        setServerError((e as Error).message)
      })
  }, [])

  useEffect(() => {
    refreshServer()
    const timer = window.setInterval(refreshServer, 10000)
    return () => window.clearInterval(timer)
  }, [refreshServer])

  const onConnect = async () => {
    setBusy('connect')
    try {
      const c = await connect()
      setConn(c)
      say(`Connected to BSV Desktop on ${c.network}.`)
      if (c.network !== 'mainnet') {
        say(
          `The wallet is on ${c.network}, but Upstream runs on mainnet. Switch BSV Desktop to mainnet before funding.`,
          { bad: true }
        )
      }
    } catch (e) {
      sayFailure('Could not connect', e)
    } finally {
      setBusy(null)
    }
  }

  /** Report a transaction to the server; shared by the normal and salvage paths. */
  const record = async (scope: FundingScope, txid: string, beefHex: string) => {
    const saved = await postFunding({ scope, txid, beefHex })
    setFunded((f) => [saved, ...f.filter((r) => r.txid !== saved.txid)])
    say(`Funding verified; ${saved.outputs.length} agents are ready to spend.`)
    refreshServer()
  }

  const doFund = async (scope: FundingScope) => {
    if (!conn || settled) return
    setBusy(scope)
    try {
      const h = await getHealth()
      if (h.dryRun !== false)
        throw new Error('The backend must be in live mode before funding.')
      const plan = await getFundingPlan(scope)

      if (plan.network !== conn.network) {
        say(
          `Refusing to spend: the server expects ${plan.network}, the wallet is on ${conn.network}.`,
          { bad: true }
        )
        return
      }

      const already = plan.alreadyFunded.filter((f) => f.scope === scope)
      const what =
        scope === 'lisa'
          ? `Fund Lisa's agent with ${sats(plan.totalSats)} sats?`
          : `Fund ${plan.targets.length} agents with ${sats(plan.totalSats)} sats in one transaction?`
      const warn =
        already.length > 0
          ? `\n\nWarning: scope "${scope}" was already funded (${already
              .map((a) => a.txid.slice(0, 12))
              .join(', ')}). Funding again spends more real satoshis.`
          : ''

      if (
        !window.confirm(
          `${what}\n\nThis is MAINNET. The satoshis are real.${warn}`
        )
      ) {
        say('Cancelled.')
        return
      }

      say(
        `Open BSV Desktop to review ${sats(plan.totalSats)} sats plus the wallet fee.`
      )
      const description = `Upstream fund ${plan.totalSats} sats`

      try {
        const { txid, beefHex, indexes } = await fundAgents(
          conn.wallet,
          plan.targets,
          description
        )
        say(
          `Broadcast ${sats(plan.totalSats)} sats to ${plan.targets.length} agent(s).`,
          { txid }
        )
        await record(scope, txid, beefHex)

        const missing = indexes.filter((i) => i.index < 0)
        if (missing.length > 0) {
          say(
            `${missing.length} target(s) could not be located in the transaction.`,
            { bad: true }
          )
        }
      } catch (e) {
        sayFailure('Funding failed', e)
        if (e instanceof WalletCallError && e.salvaged !== null) {
          say(
            'The wallet produced a transaction before failing. Check it in BSV Desktop before retrying.',
            { bad: true, txid: e.salvaged.txid }
          )
        }
        void checkActions()
      }

      void spendableBalance(conn.wallet).then((b) =>
        setConn((c) => (c ? { ...c, balance: b } : c))
      )
    } catch (e) {
      sayFailure('Funding failed', e)
    } finally {
      setBusy(null)
    }
  }

  const checkActions = useCallback(async () => {
    if (!conn) return
    setBusy('actions')
    try {
      const { actions: found, stuck } = await listFundingActions(conn.wallet)
      setActions(found)
      if (found.length === 0) {
        say(
          'No labelled funding actions found. Check BSV Desktop history for older or unlabelled actions before retrying.'
        )
      } else if (stuck.length === 0) {
        say(`${found.length} funding action(s) in the wallet, none unfinished.`)
      } else {
        say(
          `${stuck.length} unfinished funding action(s): ${stuck
            .map((a) => `${a.status} ${a.txid.slice(0, 12)}`)
            .join(', ')}. Clear these in BSV Desktop before retrying.`,
          { bad: true }
        )
      }
    } catch (e) {
      sayFailure('Could not list wallet actions', e)
    } finally {
      setBusy(null)
    }
  }, [conn, say, sayFailure])

  const onAttest = async () => {
    if (!conn || !lisa) return
    setBusy('attest')
    try {
      const att = await attestAgent(conn.wallet, lisa.agentPubKey)
      const stored = await postAttestation(att)
      // The server stores only signatures that verify, so reaching here is success.
      say(
        `BSV Desktop vouched for ${stored.label}; the server verified and saved the signature.`
      )
      refreshServer()
    } catch (e) {
      sayFailure('Signing failed', e)
    } finally {
      setBusy(null)
    }
  }

  const fundingReceipt = plan?.alreadyFunded.find((r) => r.scope === 'all')
  const onMainnet = conn?.network === 'mainnet'
  const ready =
    Boolean(conn) &&
    !settled &&
    onMainnet &&
    health?.dryRun === false &&
    serverError === null &&
    busy === null

  return (
    <div className="wallet-panel" hidden={stage === null}>
      <section hidden={stage !== 'fund'}>
        <div className="step-label">1 · Fund the agents</div>
        <h2>
          {fundingReceipt
            ? `${sats(fundingReceipt.totalSats)} sats funded`
            : plan
              ? `${sats(plan.totalSats)} sats from your wallet`
              : 'Connect your BSV wallet'}
        </h2>
        <p className="muted">
          {fundingReceipt
            ? `Your budget was sent to ${fundingReceipt.agents} agent wallets. The transaction is recorded below.`
            : `One payment funds ${plan?.targets.length ?? 'the'} agent wallets. Open BSV Desktop, review the amount and fee, then approve there.`}
        </p>
        <div
          className="controls"
          hidden={settled || (Boolean(fundingReceipt) && Boolean(conn))}
        >
          <button onClick={() => void onConnect()} disabled={busy !== null}>
            {busy === 'connect'
              ? 'Open BSV Desktop to connect…'
              : conn
                ? `Connected · ${conn.network}`
                : 'Connect BSV Desktop'}
          </button>
          <button
            className="primary"
            hidden={Boolean(fundingReceipt)}
            onClick={() => void doFund('all')}
            disabled={!ready || !plan}
          >
            {busy === 'all'
              ? 'Review payment in BSV Desktop…'
              : `Review ${plan ? sats(plan.totalSats) : '—'} sats in wallet`}
          </button>
        </div>
        {conn && (
          <p className="muted">
            Wallet balance:{' '}
            {conn.balance === null
              ? 'not shared'
              : `${sats(conn.balance)} sats`}
            . Wallet spending permissions determine whether a new approval
            prompt appears.
          </p>
        )}
        {serverError && (
          <p className="bad" role="alert">
            {serverError}
          </p>
        )}
        {plan?.alreadyFunded.map((r) => (
          <p key={r.txid} className="small">
            Funded {r.agents} agents · {sats(r.totalSats)} sats ·{' '}
            <a href={explorerTxUrl(r.txid)} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          </p>
        ))}
        <details>
          <summary>Funding details and recovery</summary>
          <p className="muted">
            Agent wallets run locally. Funding transfers this budget to them;
            the sponsor’s matching pool stays in BSV Desktop.
          </p>
          <div className="controls">
            <button onClick={() => void doFund('lisa')} disabled={!ready}>
              Fund Lisa only (small test)
            </button>
            <button
              onClick={() => void checkActions()}
              disabled={!conn || busy !== null}
            >
              Check unfinished wallet actions
            </button>
          </div>
          {plan && (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Address</th>
                    <th className="num">Sats</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.targets.map((t) => (
                    <tr key={t.label}>
                      <td>{t.label}</td>
                      <td className="mono small">{t.address}</td>
                      <td className="num">{sats(t.satoshis)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {actions?.map((a) => (
            <p key={a.txid} className="small">
              {a.status} · {a.description} · {sats(a.satoshis)} sats
            </p>
          ))}
        </details>
      </section>
      <div hidden={stage !== 'pay'}>
        <PaymentPanel
          settled={settled}
          live={health?.dryRun === false}
          fundingVersion={funded.length}
        >
          <p className="muted">
            Lisa’s agent:{' '}
            {lisa?.attested
              ? 'owner signature verified'
              : 'needs your owner signature before paying'}
            .
          </p>
          {!lisa?.attested && (
            <button onClick={() => void onAttest()} disabled={!ready || !lisa}>
              {busy === 'attest'
                ? 'Review signature in BSV Desktop…'
                : 'Authorize Lisa in BSV Desktop'}
            </button>
          )}
        </PaymentPanel>
      </div>
      <div hidden={stage !== 'settle' || settled}>
        <SettlementPanel conn={conn} walletBusy={busy !== null} />
      </div>
      {log.length > 0 && (
        <section aria-live="polite">
          <h2>Wallet activity</h2>
          <ul className="log">
            {log.map((l, i) => (
              <li key={i} className={l.bad ? 'bad' : undefined}>
                {l.text}
                {l.txid && (
                  <>
                    {' '}
                    <a
                      href={explorerTxUrl(l.txid)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View transaction ↗
                    </a>
                  </>
                )}
                {(l.detail || l.diagnosis) && (
                  <details>
                    <summary>Wallet details</summary>
                    {l.diagnosis && <DiagnosisCard d={l.diagnosis} />}
                    {l.detail && <pre>{l.detail}</pre>}
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** A wallet failure, with the wallet's exact words first. */
function DiagnosisCard({ d }: { d: Diagnosis }) {
  return (
    <div className="diagnosis">
      <p className="diagnosis-title">{d.title}</p>
      <pre className="exact">{d.exact}</pre>
      <p className="diagnosis-meaning">{d.meaning}</p>
      <p className="diagnosis-side">
        {d.side === 'wallet' &&
          'This is a wallet-side failure. Nothing in this app can avoid it.'}
        {d.side === 'app' && 'This is our bug, not the wallet’s.'}
        {d.side === 'unknown' && 'Which side is at fault is not yet clear.'}
        {d.nothingSent
          ? ' Nothing was broadcast, so retrying cannot double-spend.'
          : ' Check the explorer before retrying — a transaction may exist.'}
      </p>
      <ol className="diagnosis-try">
        {d.tryThis.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
    </div>
  )
}
