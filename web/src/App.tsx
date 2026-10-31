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
import { DEFAULT_ROUND } from '@upstream/shared'
import { explorerTxUrl, type FundingRecord, type FundingScope } from '@upstream/shared/funding'
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
import {
  WalletCallError,
  attestAgent,
  connect,
  fundAgents,
  listFundingActions,
  spendableBalance,
  type Connection
} from './wallet'
import './style.css'

type Busy = null | 'connect' | 'lisa' | 'all' | 'attest' | 'actions'

interface LogLine {
  text: string
  txid?: string
  bad?: boolean
  detail?: string
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [conn, setConn] = useState<Connection | null>(null)
  const [lisa, setLisa] = useState<LisaAgent | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [funded, setFunded] = useState<FundingRecord[]>([])
  const [actions, setActions] = useState<WalletAction[] | null>(null)

  const say = useCallback((text: string, opts: Omit<LogLine, 'text'> = {}) => {
    setLog(l => [{ text, ...opts }, ...l])
  }, [])

  /** Log a wallet failure with everything we could recover about it. */
  const sayFailure = useCallback(
    (what: string, e: unknown) => {
      if (e instanceof WalletCallError) {
        console.error(`${what}\n${e.detail}`)
        say(`${what}: ${e.message}`, { bad: true, detail: e.detail })
      } else {
        const msg = (e as Error).message
        console.error(what, e)
        say(`${what}: ${msg}`, { bad: true, detail: String((e as Error).stack ?? msg) })
      }
    },
    [say]
  )

  const refreshServer = useCallback(() => {
    void getHealth()
      .then(h => {
        setHealth(h)
        setServerError(null)
      })
      .catch(e => setServerError((e as Error).message))
    void getLisaAgent()
      .then(setLisa)
      .catch(() => setLisa(null))
  }, [])

  useEffect(refreshServer, [refreshServer])

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
    setFunded(f => [saved, ...f.filter(r => r.txid !== saved.txid)])
    say(`Server recorded ${saved.outputs.length} output(s) and saved ${saved.beefPath}.`)
    refreshServer()
  }

  const doFund = async (scope: FundingScope) => {
    if (!conn) return
    setBusy(scope)
    try {
      const plan = await getFundingPlan(scope)

      if (plan.network !== conn.network) {
        say(
          `Refusing to spend: the server expects ${plan.network}, the wallet is on ${conn.network}.`,
          { bad: true }
        )
        return
      }

      const already = plan.alreadyFunded.filter(f => f.scope === scope)
      const what =
        scope === 'lisa'
          ? `Fund Lisa's agent with ${sats(plan.totalSats)} sats?`
          : `Fund ${plan.targets.length} agents with ${sats(plan.totalSats)} sats in one transaction?`
      const warn =
        already.length > 0
          ? `\n\nWarning: scope "${scope}" was already funded (${already
              .map(a => a.txid.slice(0, 12))
              .join(', ')}). Funding again spends more real satoshis.`
          : ''

      if (!window.confirm(`${what}\n\nThis is MAINNET. The satoshis are real.${warn}`)) {
        say('Cancelled.')
        return
      }

      const description =
        scope === 'lisa' ? 'Fund Lisa agent (smoke test)' : 'Fund Upstream agents'

      try {
        const { txid, beefHex, indexes } = await fundAgents(conn.wallet, plan.targets, description)
        say(`Broadcast ${sats(plan.totalSats)} sats to ${plan.targets.length} agent(s).`, { txid })
        await record(scope, txid, beefHex)

        const missing = indexes.filter(i => i.index < 0)
        if (missing.length > 0) {
          say(`${missing.length} target(s) could not be located in the transaction.`, { bad: true })
        }
      } catch (e) {
        sayFailure('Funding failed', e)
        // If the wallet signed before failing, the transaction may be real.
        // Record it rather than risk funding the same agents twice.
        if (e instanceof WalletCallError && e.salvaged !== null) {
          say(
            `The wallet produced transaction ${e.salvaged.txid} before failing — recording it so a retry cannot double-fund. Check the explorer link before retrying.`,
            { bad: true, txid: e.salvaged.txid }
          )
          try {
            await record(scope, e.salvaged.txid, e.salvaged.beefHex)
          } catch (inner) {
            say(`Could not record the salvaged transaction: ${(inner as Error).message}`, {
              bad: true
            })
          }
        }
        void checkActions()
      }

      void spendableBalance(conn.wallet).then(b => setConn(c => (c ? { ...c, balance: b } : c)))
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
        say('The wallet holds no labelled funding actions. Nothing is reserved; it is safe to retry.')
      } else if (stuck.length === 0) {
        say(`${found.length} funding action(s) in the wallet, none unfinished.`)
      } else {
        say(
          `${stuck.length} unfinished funding action(s): ${stuck
            .map(a => `${a.status} ${a.txid.slice(0, 12)}`)
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
      say(`BSV Desktop vouched for ${stored.label}; the server verified and saved the signature.`)
      refreshServer()
    } catch (e) {
      sayFailure('Signing failed', e)
    } finally {
      setBusy(null)
    }
  }

  const onMainnet = conn?.network === 'mainnet'
  const ready = Boolean(conn) && busy === null

  return (
    <main>
      <h1>Upstream</h1>
      <p className="tagline">
        AI agents pay the open-source projects they use. A sponsor pool is split by quadratic
        funding, so many independent supporters beat one whale. Everything settles on BSV.
      </p>

      <section>
        <h2>1 · Wallet</h2>
        {conn ? (
          <dl>
            <dt>Identity key</dt>
            <dd className="mono wrap">{conn.identityKey}</dd>
            <dt>Network</dt>
            <dd className={onMainnet ? 'ok' : 'bad'}>{conn.network}</dd>
            <dt>Spendable</dt>
            <dd>
              {conn.balance === null ? 'not shared by the wallet' : `${sats(conn.balance)} sats`}
            </dd>
          </dl>
        ) : (
          <p className="muted">BSV Desktop must be open, unlocked and on mainnet.</p>
        )}
        <button onClick={() => void onConnect()} disabled={busy === 'connect'}>
          {busy === 'connect'
            ? 'Connecting…'
            : conn
              ? 'Reconnect BSV Desktop'
              : 'Connect BSV Desktop'}
        </button>
      </section>

      <section>
        <h2>2 · Wallet actions</h2>
        <p className="muted">
          Check whether the wallet is holding an unfinished funding action. An action left
          <code> unsigned</code> or <code> failed</code> keeps its inputs reserved, so clear it
          before retrying.
        </p>
        <button onClick={() => void checkActions()} disabled={!ready}>
          {busy === 'actions' ? 'Asking the wallet…' : 'Check for stuck actions'}
        </button>
        {actions !== null && actions.length > 0 && (
          <div className="scroll" style={{ marginTop: '1rem' }}>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Txid</th>
                  <th className="num">Sats</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {actions.map(a => (
                  <tr key={a.txid}>
                    <td className={a.status === 'completed' ? 'ok' : 'bad'}>{a.status}</td>
                    <td className="mono small">
                      <a href={explorerTxUrl(a.txid)} target="_blank" rel="noreferrer">
                        {a.txid.slice(0, 16)}…
                      </a>
                    </td>
                    <td className="num">{sats(a.satoshis)}</td>
                    <td className="small">{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>3 · Smoke test</h2>
        <p className="muted">
          Send only Lisa&rsquo;s agent its funding first. One output, one small amount — enough to
          prove the whole path works before spending the rest.
        </p>
        <button className="primary" onClick={() => void doFund('lisa')} disabled={!ready}>
          {busy === 'lisa' ? 'Funding Lisa…' : 'Fund Lisa only'}
        </button>
      </section>

      <section>
        <h2>4 · Full fan-out</h2>
        <p className="muted">
          One transaction with an output for every agent, at the amounts in <code>.env</code>.
        </p>
        <button className="danger" onClick={() => void doFund('all')} disabled={!ready}>
          {busy === 'all' ? 'Funding all agents…' : 'Fund all agents'}
        </button>
      </section>

      <section>
        <h2>5 · Vouch for Lisa&rsquo;s agent</h2>
        <p className="muted">
          BSV Desktop signs Lisa&rsquo;s agent public key, so the tally can count her as one real
          owner.
          {lisa?.attested ? ' Already signed and verified.' : ''}
        </p>
        <button onClick={() => void onAttest()} disabled={!ready || lisa === null}>
          {busy === 'attest' ? 'Waiting for the wallet…' : "Sign Lisa's agent key"}
        </button>
      </section>

      {funded.length > 0 && (
        <section>
          <h2>Funded agents</h2>
          {funded.map(r => (
            <div key={r.txid} className="record">
              <p>
                <strong>{r.scope}</strong> · {sats(r.totalSats)} sats · {r.outputs.length}{' '}
                output(s) ·{' '}
                <a href={explorerTxUrl(r.txid)} target="_blank" rel="noreferrer">
                  {r.txid.slice(0, 16)}…
                </a>
              </p>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Output</th>
                      <th>Agent</th>
                      <th>Address</th>
                      <th className="num">Sats</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.outputs.map(o => (
                      <tr key={o.index}>
                        <td className="mono">#{o.index}</td>
                        <td>{o.label}</td>
                        <td className="mono small">{o.address}</td>
                        <td className="num">{sats(o.satoshis)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Activity</h2>
        {log.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="log">
          {log.map((l, i) => (
            <li key={i} className={l.bad === true ? 'bad' : undefined}>
              {l.text}
              {l.txid !== undefined && (
                <>
                  {' '}
                  <a href={explorerTxUrl(l.txid)} target="_blank" rel="noreferrer">
                    {l.txid}
                  </a>
                </>
              )}
              {l.detail !== undefined && (
                <details>
                  <summary>Full wallet response</summary>
                  <pre>{l.detail}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>

      <footer>
        <span>Round {health?.round ?? DEFAULT_ROUND}</span>
        <span className={health !== null && health.network === 'mainnet' ? 'ok' : 'bad'}>
          {serverError !== null
            ? `server unreachable: ${serverError}`
            : `server ${health?.network ?? '…'}`}
        </span>
      </footer>
    </main>
  )
}
