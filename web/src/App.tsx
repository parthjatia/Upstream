import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import projects from '@upstream/shared/projects.json'
import { sats } from '@upstream/shared/budget'
import {
  advanceDemo,
  demoAt,
  demoPhase,
  demoTally,
  DEMO_STEPS,
  emptyDemo,
  transactionUrl
} from './dashboardModel'
import { useFundingStream } from './useFundingStream'
import { call } from './api'
import { Galaxy, projectVisuals } from './Galaxy'
import { Icon } from './Icon'
import type { Tally } from '../../server/src/contributions'
import './style.css'

const WalletPanel = lazy(() =>
  import('./WalletPanel').then((m) => ({ default: m.WalletPanel }))
)
const phases = [
  {
    title: 'An agent gets to work',
    text: 'Lisa builds a bakery website. Every library her agent uses receives a tiny payment.',
    short: 'Lisa’s first payments'
  },
  {
    title: 'Small payments. Shared impact.',
    text: 'Independent owners send agents to work. Their support builds a larger matching share for the tools they use.',
    short: 'The swarm'
  },
  {
    title: 'A crowd outweighs a whale.',
    text: 'One large donation still has one owner. It brings direct funding, but earns no quadratic match on its own.',
    short: 'Crowd vs. whale'
  },
  {
    title: 'More agents ≠ more people.',
    text: 'Agents without a valid owner signature are rejected. Matching groups contributions by owner key.',
    short: 'Identity check'
  }
]
function Modal({
  title,
  onClose,
  children,
  wide = false
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  )
}
export function App() {
  const [mode, setMode] = useState<'demo' | 'network'>('demo')
  const [demo, setDemo] = useState(emptyDemo)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [modal, setModal] = useState<'wallet' | 'how' | 'pledge' | null>(null)
  const [poolInput, setPoolInput] = useState('')
  const [poolError, setPoolError] = useState('')
  const [saving, setSaving] = useState(false)
  const [presentation, setPresentation] = useState(false)
  const live = useFundingStream(mode === 'network')
  const isDemo = mode === 'demo'
  const tally = isDemo ? demoTally(demo) : live.tally
  const feed = isDemo ? demo.feed : live.feed
  const phase = demoPhase(Math.max(0, demo.step - 1))
  const complete = demo.step >= DEMO_STEPS
  const selectedProject = projects.find((p) => p.id === selected)
  const selectedRow = tally?.rows.find((r) => r.project === selected)
  const dryRunCount = tally?.dryRunContributions ?? 0
  const realCount = (tally?.contributions ?? 0) - dryRunCount
  const modeLabel = isDemo
    ? 'Interactive demo'
    : live.status !== 'connected'
      ? 'Disconnected'
      : live.health?.dryRun === true
        ? 'DRY RUN · connected'
        : live.health?.dryRun === false
          ? `BSV ${live.health.network} · connected`
          : 'Server mode unknown'
  useEffect(() => {
    if (!playing || !isDemo || complete) return
    const timer = window.setInterval(() => setDemo((s) => advanceDemo(s)), 850)
    return () => window.clearInterval(timer)
  }, [playing, isDemo, complete])
  useEffect(() => {
    if (complete) setPlaying(false)
  }, [complete])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresentation(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const switchMode = (next: 'demo' | 'network') => {
    setPlaying(false)
    setMode(next)
    setSelected(null)
  }
  const openPledge = () => {
    setPoolInput(String(tally?.pool ?? 0))
    setPoolError('')
    setModal('pledge')
  }
  const savePledge = async () => {
    if (!/^\d+$/.test(poolInput) || !Number.isSafeInteger(Number(poolInput))) {
      setPoolError('Enter a whole number of satoshis, 0 or more.')
      return
    }
    setSaving(true)
    setPoolError('')
    try {
      if (isDemo) setDemo((s) => ({ ...s, pool: Number(poolInput) }))
      else
        await call<Tally>('/pledge', {
          method: 'POST',
          body: JSON.stringify({ pool: Number(poolInput) })
        })
      setModal(null)
    } catch (e) {
      setPoolError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className={`app ${presentation ? 'presentation' : ''}`}>
      <header className="topbar">
        <a className="brand" href="#" aria-label="Upstream home">
          <span className="brand-mark">
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path
                d="M6 25V14l6-6v17M16 25V10l6-6v21M26 25V14"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          upstream<span className="brand-beta">BETA</span>
        </a>
        <nav aria-label="Main navigation">
          <a className="active" href="#ecosystem">
            Overview
          </a>
          <a href="#projects">
            Projects <span>5</span>
          </a>
          <button onClick={() => setModal('how')}>
            How it works <Icon name="external" size={12} />
          </button>
        </nav>
        <button
          className="button wallet-button"
          onClick={() => setModal('wallet')}
        >
          <Icon name="wallet" size={16} />
          Wallet & settlement
        </button>
      </header>
      <main className="dashboard">
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              <span className="tiny-mark" /> OPEN SOURCE. ONGOING SUPPORT.
            </div>
            <h1>Give back, with every call.</h1>
            <p>Agents use open source. Now they help fund it.</p>
          </div>
          <div className="heading-controls">
            <div className="mode-switch" aria-label="Data source">
              <button
                className={isDemo ? 'chosen' : ''}
                aria-pressed={isDemo}
                onClick={() => switchMode('demo')}
              >
                Demo
              </button>
              <button
                className={!isDemo ? 'chosen' : ''}
                aria-pressed={!isDemo}
                onClick={() => switchMode('network')}
              >
                Connected network
              </button>
            </div>
            <span className="round-label">
              {tally?.round ?? 'round-1'} <span> / </span> BSV ecosystem
            </span>
          </div>
        </div>
        <div
          className={`mode-notice ${!isDemo && live.status === 'offline' ? 'notice-offline' : ''}`}
          role="status"
        >
          <span className="status-dot" />
          <strong>{modeLabel}</strong>
          <span>
            {isDemo
              ? 'A simulated round. No wallet, no real funds.'
              : live.status !== 'connected'
                ? 'Waiting for the tally server. Reconnecting automatically; displayed data may be stale.'
                : dryRunCount > 0
                  ? `${sats(dryRunCount)} simulated contributions · ${sats(realCount)} reported broadcasts. Each receipt is labelled below.`
                  : 'Payments stream from the tally server. Wallet actions require your approval.'}
          </span>
          <span className="notice-end">
            {isDemo ? 'SAFE TO EXPLORE' : 'SERVER DATA'}
          </span>
        </div>
        <div className="stats-row">
          <Metric
            label={
              isDemo || dryRunCount > 0
                ? 'Contributions recorded'
                : 'Direct funding'
            }
            value={tally ? sats(tally.totalRaised) : '—'}
            unit="sats"
            detail={
              isDemo
                ? 'Simulated payments to maintainers'
                : `${sats(realCount)} broadcast · ${sats(dryRunCount)} dry run`
            }
            icon="↗"
          />
          <Metric
            label="Matching pool"
            value={tally ? sats(tally.pool) : '—'}
            unit="sats"
            detail="Pledged by the sponsor"
            icon="◎"
          />
          <Metric
            label="Independent owners"
            value={tally ? sats(tally.owners) : '—'}
            detail="Matching counts owners, not agents"
            icon="♧"
          />
          <Metric
            label="Contributions"
            value={tally ? sats(tally.contributions) : '—'}
            detail={`${tally?.rejected ?? 0} rejected · excluded from matching`}
            icon="⌁"
          />
        </div>
        <div className="ecosystem-grid" id="ecosystem">
          <section className="panel ecosystem-panel">
            <div className="panel-heading">
              <div>
                <h2>
                  The funding ecosystem{' '}
                  <span className="badge">
                    {isDemo
                      ? 'DEMO'
                      : live.status === 'connected'
                        ? 'STREAMING'
                        : 'OFFLINE'}
                  </span>
                </h2>
                <p>Every tool call can send value upstream.</p>
              </div>
              <button
                className="icon-button"
                aria-label={
                  presentation
                    ? 'Exit presentation view'
                    : 'Enter presentation view'
                }
                title="Presentation view"
                onClick={() => setPresentation(!presentation)}
              >
                <Icon name={presentation ? 'close' : 'expand'} size={17} />
              </button>
            </div>
            <Galaxy
              rows={tally?.rows ?? []}
              feed={feed}
              selected={selected}
              onSelect={(id) => setSelected(selected === id ? null : id)}
              running={playing || (!isDemo && live.status === 'connected')}
              demo={isDemo}
            />
            {selectedProject ? (
              <div className="project-inspector">
                <span
                  className="inspector-icon"
                  style={{ color: projectVisuals[selectedProject.id]?.color }}
                >
                  <Icon name={projectVisuals[selectedProject.id]!.icon} />
                </span>
                <div>
                  <strong>{selectedProject.name}</strong>
                  <p>
                    {sats(selectedRow?.raised ?? 0)} sats contributed ·{' '}
                    {selectedRow?.supporters ?? 0} owners ·{' '}
                    {sats(selectedRow?.match ?? 0)} sats matching
                  </p>
                  <p>{selectedProject.story}</p>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close project details"
                  onClick={() => setSelected(null)}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ) : (
              <div className="map-caption">
                <Icon name="info" size={15} />
                <span>Select a project to see where the support goes.</span>
                <span>Demo libraries · real-world inspiration</span>
              </div>
            )}
          </section>
          <aside className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <h2>Payment stream</h2>
                <p>
                  {isDemo
                    ? 'Follow each simulated contribution'
                    : 'Recent events from the server'}
                </p>
              </div>
              <span
                className={`stream-light ${playing || (!isDemo && live.status === 'connected') ? 'lit' : ''}`}
              />
            </div>
            <div
              className="activity-feed"
              tabIndex={0}
              aria-label="Recent payment activity"
            >
              {feed.length === 0 ? (
                <div className="empty-feed">
                  <span className="empty-icon">
                    <Icon name="stream" size={25} />
                  </span>
                  <h3>
                    {isDemo
                      ? 'Small calls. Real potential.'
                      : 'Listening for contributions'}
                  </h3>
                  <p>
                    {isDemo
                      ? 'Start the demo to follow a payment from an agent to a maintainer.'
                      : 'New agent payments will appear here when the server receives them.'}
                  </p>
                  {isDemo && (
                    <button
                      className="text-button"
                      onClick={() => setPlaying(true)}
                    >
                      Start the demo <Icon name="arrow" size={15} />
                    </button>
                  )}
                </div>
              ) : (
                feed.map((event) => {
                  const url = transactionUrl(event)
                  return (
                    <div
                      className={`feed-event ${event.source === 'rejected' ? 'event-rejected' : ''}`}
                      key={event.id}
                    >
                      <span className={`event-symbol ${event.source}`}>
                        <Icon
                          name={
                            event.source === 'rejected' ? 'shield' : 'arrow'
                          }
                          size={15}
                        />
                      </span>
                      <div className="event-body">
                        <div>
                          <strong>{event.label}</strong>
                          <span>
                            {event.source === 'rejected'
                              ? 'Rejected'
                              : `+${sats(event.sats)}`}
                          </span>
                        </div>
                        <p>
                          {event.source === 'rejected' ? (
                            (event.reason ??
                            'Contribution could not be verified')
                          ) : (
                            <>
                              <span className="to-arrow">↳</span>{' '}
                              {event.project}{' '}
                              <span className="event-unit">sats</span>
                            </>
                          )}
                        </p>
                        <div className="receipt">
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              {event.txid!.slice(0, 10)}…{' '}
                              <Icon name="external" size={10} />
                            </a>
                          ) : (
                            <span>
                              {event.source === 'rejected'
                                ? 'Excluded from matching'
                                : 'SIMULATED · NOT BROADCAST'}
                            </span>
                          )}
                        </div>
                        {event.reason && (
                          <span className="sr-only">{event.reason}</span>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="stream-footer">
              <Icon name="shield" size={14} />
              {isDemo
                ? 'Demo receipts never link to the chain'
                : 'Broadcast receipts link to WhatsOnChain'}
            </div>
          </aside>
        </div>
        {isDemo ? (
          <section className="demo-console" aria-label="Demo playback">
            <div className="demo-story">
              <span className="demo-step">
                {complete ? (
                  <Icon name="check" size={20} />
                ) : (
                  String(phase + 1).padStart(2, '0')
                )}
              </span>
              <div aria-live="polite">
                <h3>
                  {complete ? 'Usage becomes support.' : phases[phase]!.title}
                </h3>
                <p>
                  {complete
                    ? 'The round is complete. Explore the matching results, or replay the story.'
                    : phases[phase]!.text}
                </p>
              </div>
              <div className="playback">
                <button
                  className="icon-button"
                  aria-label="Reset demo"
                  onClick={() => {
                    setDemo(emptyDemo())
                    setPlaying(false)
                  }}
                >
                  <Icon name="reset" size={17} />
                </button>
                <button
                  className="button primary"
                  onClick={() => {
                    if (complete) setDemo(emptyDemo())
                    setPlaying(!playing)
                  }}
                >
                  <Icon name={playing ? 'pause' : 'play'} size={15} />
                  {playing
                    ? 'Pause'
                    : complete
                      ? 'Replay demo'
                      : demo.step > 0
                        ? 'Continue'
                        : 'Start demo'}
                </button>
              </div>
            </div>
            <div className="chapter-list">
              {phases.map((p, i) => (
                <button
                  key={p.short}
                  className={
                    phase === i ? 'current' : phase > i ? 'finished' : ''
                  }
                  onClick={() => {
                    setDemo(demoAt([0, 5, 45, 52][i]!))
                    setPlaying(true)
                  }}
                >
                  <span>{i + 1}</span>
                  {p.short}
                  <span className="chapter-line">
                    <i
                      style={{
                        width: `${phase > i ? 100 : phase === i ? Math.min(100, ((demo.step - [0, 5, 45, 52][i]!) / [5, 40, 7, 10][i]!) * 100) : 0}%`
                      }}
                    />
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div className="network-instructions">
            <Icon name="info" size={17} />
            <p>
              The network view observes your running agents. Start agents from
              the terminal; use{' '}
              <button
                className="inline-button"
                onClick={() => setModal('wallet')}
              >
                Wallet & settlement
              </button>{' '}
              to fund them or settle matching. Changing views does not change
              the server’s payment mode.
            </p>
          </div>
        )}
        <div className="results-grid" id="projects">
          <section className="panel project-table-panel">
            <div className="panel-heading">
              <div>
                <h2>Support where it’s used</h2>
                <p>Five demo projects. One healthier open-source ecosystem.</p>
              </div>
              <span className="table-unit">ALL AMOUNTS IN SATS</span>
            </div>
            <div className="table-scroll">
              <table className="projects-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Owners</th>
                    <th>Contributed</th>
                    <th>Matching</th>
                    <th>Pool share</th>
                  </tr>
                </thead>
                <tbody>
                  {[...projects]
                    .sort(
                      (a, b) =>
                        (tally?.rows.find((r) => r.project === b.id)?.match ??
                          0) -
                        (tally?.rows.find((r) => r.project === a.id)?.match ??
                          0)
                    )
                    .map((project) => {
                      const row = tally?.rows.find(
                        (r) => r.project === project.id
                      )
                      const v = projectVisuals[project.id]!
                      const percent = tally?.pool
                        ? ((row?.match ?? 0) / tally.pool) * 100
                        : 0
                      return (
                        <tr key={project.id}>
                          <td>
                            <button
                              className="project-table-button"
                              onClick={() => {
                                setSelected(project.id)
                                document
                                  .getElementById('ecosystem')
                                  ?.scrollIntoView({
                                    behavior: window.matchMedia(
                                      '(prefers-reduced-motion: reduce)'
                                    ).matches
                                      ? 'instant'
                                      : 'smooth'
                                  })
                              }}
                            >
                              <span
                                className="project-avatar"
                                style={
                                  {
                                    '--project-color': v.color
                                  } as CSSProperties
                                }
                              >
                                <Icon name={v.icon} size={17} />
                              </span>
                              <span>
                                <strong>{project.id}</strong>
                                <small>{v.category} · demo</small>
                              </span>
                            </button>
                          </td>
                          <td>{row?.supporters ?? 0}</td>
                          <td>{sats(row?.raised ?? 0)}</td>
                          <td className="match-cell">
                            {sats(row?.match ?? 0)}
                          </td>
                          <td>
                            <div className="share-cell">
                              <div>
                                <i
                                  style={{
                                    width: `${percent}%`,
                                    background: v.color
                                  }}
                                />
                              </div>
                              <span>{percent.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <Icon name="people" size={15} />
              Multiple agents belonging to one owner count together.
            </div>
          </section>
          <aside className="matching-card">
            <div className="matching-eyebrow">
              <span>THE MULTIPLIER</span>
              <Icon name="stream" size={20} />
            </div>
            <h2>
              Many small voices.
              <br />A bigger impact.
            </h2>
            <p>
              Quadratic funding rewards broad support. More independent owners
              unlock a larger share of the sponsor’s pool.
            </p>
            <div className="matching-total">
              <span>Available matching pool</span>
              <strong>
                {tally ? sats(tally.pool) : '—'} <small>sats</small>
              </strong>
            </div>
            <button
              className="button"
              disabled={!isDemo && (!tally || live.status !== 'connected')}
              onClick={openPledge}
            >
              Adjust {isDemo ? 'demo ' : ''}pledge{' '}
              <Icon name="arrow" size={16} />
            </button>
            <span className="matching-note">
              {isDemo
                ? 'Simulated pool. Explore how the split changes.'
                : 'Funds stay in the sponsor’s wallet until settlement.'}
            </span>
            {live.settled && !isDemo && (
              <a
                className="settled-link"
                href={`https://whatsonchain.com/tx/${live.settled}`}
                target="_blank"
                rel="noreferrer"
              >
                View settlement <Icon name="external" size={14} />
              </a>
            )}
          </aside>
        </div>
        <footer className="page-footer">
          <span className="footer-brand">
            ↑ upstream <span>Usage becomes support.</span>
          </span>
          <span>
            Built for TUM Blockchain & AI Hackathon{' '}
            <span className="footer-dot">·</span> Powered by BSV
          </span>
          <a
            href="https://github.com/parthjatia/Upstream"
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="github" size={15} />
            Source code <Icon name="external" size={11} />
          </a>
        </footer>
      </main>
      {presentation && (
        <button
          className="exit-presentation button"
          onClick={() => setPresentation(false)}
        >
          <Icon name="close" size={14} />
          Exit presentation
        </button>
      )}
      {modal === 'wallet' && (
        <Modal title="Wallet & settlement" onClose={() => setModal(null)} wide>
          <div className="wallet-warning">
            <Icon name="info" size={17} />
            <span>
              These controls connect to your real BSV wallet, even while the
              dashboard shows a demo. Funding and settlement spend real satoshis
              after confirmation.
            </span>
          </div>
          <Suspense
            fallback={<p className="loading">Loading wallet controls…</p>}
          >
            <WalletPanel />
          </Suspense>
        </Modal>
      )}
      {modal === 'how' && (
        <Modal title="How value flows upstream" onClose={() => setModal(null)}>
          <div className="how-content">
            <p className="modal-lead">
              The tools agents depend on deserve support.
            </p>
            {[
              {
                title: 'An agent uses a library',
                text: 'A paid tool sends a small contribution directly to that demo project before it runs.'
              },
              {
                title: 'Independent support earns matching',
                text: 'Contributions are grouped by owner identity key. The square-root formula gives broadly supported projects more matching weight.'
              },
              {
                title: 'The sponsor settles the round',
                text: 'Matching stays in the sponsor’s wallet until they approve a transaction paying each project directly.'
              }
            ].map((item, i) => (
              <div className="how-step" key={item.title}>
                <span>{i + 1}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </div>
              </div>
            ))}
            <div className="explanation-note">
              A satoshi is 1/100,000,000 of a BSV. These five libraries are demo
              projects inspired by real open-source incidents. Owner signatures
              prove control of keys; they do not prove unique humans.
            </div>
            <button
              className="button primary"
              onClick={() => {
                setModal(null)
                switchMode('demo')
                setDemo(emptyDemo())
                setPlaying(true)
              }}
            >
              See it in action <Icon name="play" size={14} />
            </button>
          </div>
        </Modal>
      )}
      {modal === 'pledge' && (
        <Modal
          title={isDemo ? 'Adjust the demo pool' : 'Update the sponsor pledge'}
          onClose={() => {
            if (!saving) setModal(null)
          }}
        >
          <form
            className="pledge-form"
            onSubmit={(e) => {
              e.preventDefault()
              void savePledge()
            }}
          >
            <p>
              {isDemo
                ? 'Change the simulated pool to see how much each project would receive.'
                : 'Set the pool used to calculate matching. This updates the round’s pledge; it does not transfer funds.'}
            </p>
            <label htmlFor="pool">Matching pool in satoshis</label>
            <div className="amount-input">
              <input
                id="pool"
                inputMode="numeric"
                autoFocus
                value={poolInput}
                onChange={(e) => setPoolInput(e.target.value)}
                aria-describedby={poolError ? 'pool-error' : undefined}
              />
              <span>sats</span>
            </div>
            {poolError && (
              <p id="pool-error" className="form-error" role="alert">
                {poolError}
              </p>
            )}
            <button className="button primary" disabled={saving}>
              {saving ? 'Saving…' : isDemo ? 'Update demo pool' : 'Save pledge'}
              <Icon name="arrow" size={15} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  )
}
function Metric({
  label,
  value,
  unit,
  detail,
  icon
}: {
  label: string
  value: string
  unit?: string
  detail: string
  icon: string
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <span>{icon}</span>
      </div>
      <div className="metric-value">
        {value}
        {unit && <span>{unit}</span>}
      </div>
      <p>{detail}</p>
    </div>
  )
}
