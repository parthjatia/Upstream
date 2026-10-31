/**
 * Phase 3 — fund the agents from BSV Desktop.
 *
 * Mainnet, real money, so the order is deliberate: connect, smoke-test with
 * Lisa alone, then the full fan-out behind a confirmation that names the total.
 * All signing happens in BSV Desktop; this page never asks for a key.
 */
import { useCallback, useEffect, useState } from 'react'
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
import { attestAgent, connect, spendableBalance, fundAgents, type Connection } from './wallet'
import './style.css'

type Busy = null | 'connect' | 'lisa' | 'all' | 'attest'

interface LogLine {
  text: string
  txid?: string
  bad?: boolean
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [conn, setConn] = useState<Connection | null>(null)
  const [lisa, setLisa] = useState<LisaAgent | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [funded, setFunded] = useState<FundingRecord[]>([])

  const say = useCallback((text: string, opts: { txid?: string; bad?: boolean } = {}) => {
    setLog(l => [{ text, ...opts }, ...l])
  }, [])

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
      say(`Could not connect: ${(e as Error).message}`, { bad: true })
    } finally {
      setBusy(null)
    }
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
      const { txid, beefHex, indexes } = await fundAgents(conn.wallet, plan.targets, description)
      say(`Broadcast ${sats(plan.totalSats)} sats to ${plan.targets.length} agent(s).`, { txid })

      const record = await postFunding({ scope, txid, beefHex })
      setFunded(f => [record, ...f.filter(r => r.txid !== record.txid)])
      say(`Server recorded ${record.outputs.length} output(s) and saved ${record.beefPath}.`)

      const missing = indexes.filter(i => i.index < 0)
      if (missing.length > 0) {
        say(`${missing.length} target(s) could not be located in the transaction.`, { bad: true })
      }

      void spendableBalance(conn.wallet).then(b => setConn(c => (c ? { ...c, balance: b } : c)))
      refreshServer()
    } catch (e) {
      say(`Funding failed: ${(e as Error).message}`, { bad: true })
    } finally {
      setBusy(null)
    }
  }

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
      say(`Signing failed: ${(e as Error).message}`, { bad: true })
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
        <h2>2 · Smoke test</h2>
        <p className="muted">
          Send only Lisa&rsquo;s agent its funding first. One output, one small amount — enough to
          prove the whole path works before spending the rest.
        </p>
        <button className="primary" onClick={() => void doFund('lisa')} disabled={!ready}>
          {busy === 'lisa' ? 'Funding Lisa…' : 'Fund Lisa only'}
        </button>
      </section>

      <section>
        <h2>3 · Full fan-out</h2>
        <p className="muted">
          One transaction with an output for every agent, at the amounts in <code>.env</code>.
        </p>
        <button className="danger" onClick={() => void doFund('all')} disabled={!ready}>
          {busy === 'all' ? 'Funding all agents…' : 'Fund all agents'}
        </button>
      </section>

      <section>
        <h2>4 · Vouch for Lisa&rsquo;s agent</h2>
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
