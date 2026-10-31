import { useEffect, useState, type ReactNode } from 'react'
import { sats } from '@upstream/shared/budget'
import projects from '@upstream/shared/projects.json'
import type {
  PaymentGroup,
  PaymentRun,
  PaymentStatus
} from '../../shared/paymentRun'
import { call } from './api'

export function PaymentPanel({
  live,
  settled = false,
  fundingVersion,
  children
}: {
  live: boolean
  settled?: boolean
  fundingVersion: number
  children: ReactNode
}) {
  const [status, setStatus] = useState<PaymentStatus | null>(null)
  const [project, setProject] = useState(projects[0]!.id)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const refresh = async () => {
    try {
      setStatus(await call<PaymentStatus>('/agent-payments'))
      setLoadError('')
    } catch (e) {
      setStatus(null)
      setLoadError((e as Error).message)
    }
  }
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [fundingVersion, live])
  const start = async (group: PaymentGroup) => {
    if (!status) return
    setSending(true)
    setError('')
    try {
      const run = await call<PaymentRun>('/agent-payments', {
        method: 'POST',
        body: JSON.stringify({
          id: crypto.randomUUID(),
          token: status.token,
          group,
          projectId: project
        })
      })
      setStatus((s) => (s ? { ...s, run } : s))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  const busy = sending || status?.run?.state === 'running'
  return (
    <section>
      <div className="step-label">2 · Send microtransactions</div>
      <h2>
        {settled
          ? 'Agent payments complete'
          : status
            ? `${sats(status.satsPerPayment)} ${status.satsPerPayment === 1 ? 'sat' : 'sats'} per agent payment`
            : 'Agent payments'}
      </h2>
      <p className="muted">
        {settled
          ? 'This round is settled. You can inspect its transaction receipts below.'
          : 'Choose a project to receive a separate payment from each agent.'}
      </p>
      <div className="controls" hidden={settled}>
        <select
          aria-label="Project to pay"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          disabled={busy}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className="primary"
          onClick={() => void start('swarm')}
          disabled={!live || busy || !status?.groups.swarm.ready}
        >
          {busy
            ? 'Sending agent payments…'
            : status
              ? `Run ${status.groups.swarm.count} payments · ${sats(status.groups.swarm.count * status.satsPerPayment)} sats + fees`
              : 'Run agent payments'}
        </button>
      </div>
      <details hidden={settled}>
        <summary>Single payment from Lisa</summary>
        {children}
        <button
          onClick={() => void start('lisa')}
          disabled={!live || busy || !status?.groups.lisa.ready}
        >
          Send one payment
        </button>
        {status?.groups.lisa.reason && (
          <p className="muted">{status.groups.lisa.reason}</p>
        )}
      </details>
      {loadError && (
        <p className="bad" role="alert">
          {loadError}
        </p>
      )}
      {!settled && status?.groups.swarm.reason && (
        <p className="muted">{status.groups.swarm.reason}</p>
      )}
      {!settled && status?.run && (
        <p
          role="status"
          className={status.run.state === 'failed' ? 'bad' : 'ok'}
        >
          {status.run.completed} / {status.run.total} payments recorded ·{' '}
          {status.run.state}
          {status.run.error ? `: ${status.run.error}` : ''}
        </p>
      )}
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
