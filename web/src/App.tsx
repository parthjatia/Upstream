import { useEffect, useRef, useState } from 'react'
import { WalletPanel } from './WalletPanel'
import { useFundingStream } from './useFundingStream'
import { transactionUrl } from './dashboardModel'
import { sats } from '@upstream/shared/budget'
import { quadraticMatch } from '@upstream/shared/quadratic'
import projects from '@upstream/shared/projects.json'
import './style.css'

const chapters = [
  'The problem',
  'The budget',
  'Small payments',
  'The matching',
  'Who gets what'
]
const headings = [
  <>
    AI uses open source.
    <br />
    <em>Maintainers need funding.</em>
  </>,
  <>
    Give your agents
    <br />
    <em>a small spending budget.</em>
  </>,
  <>
    Use a project.
    <br />
    <em>Pay that project.</em>
  </>,
  <>
    More supporters.
    <br />
    <em>A bigger matching share.</em>
  </>,
  <>
    See exactly
    <br />
    <em>who gets what.</em>
  </>
]
const purposes: Record<string, string> = {
  'tiny-tls': 'Secure connections',
  'stream-utils': 'Data streams',
  'log-helper': 'Application logs',
  'color-text': 'Terminal output',
  'compress-lite': 'File compression'
}
// An explanation of the actual matching function, never inserted into live data.
const example = quadraticMatch(
  [
    ...Array.from({ length: 10 }, (_, i) => ({
      project: 'crowd',
      owner: `owner-${i}`,
      sats: 1
    })),
    { project: 'single', owner: 'one-owner', sats: 10 }
  ],
  100
)

export function App() {
  const [chapter, setChapter] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)
  const live = useFundingStream(true)
  const tally = live.settlement?.results ?? live.tally
  const matchedProjects = tally?.rows.filter((row) => row.match > 0) ?? []
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    heading.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [chapter])
  const stage =
    chapter === 1
      ? 'fund'
      : chapter === 2
        ? 'pay'
        : chapter === 4
          ? 'settle'
          : null
  const exampleMatch = (id: string) =>
    example.find((row) => row.project === id)?.match ?? 0
  return (
    <main className="app walkthrough">
      <header className="page-header">
        <a className="brand" href="/">
          upstream<span>Open-source funding, explained.</span>
        </a>
        <span
          className={`connection ${live.status === 'connected' ? 'online' : ''}`}
        >
          {live.status !== 'connected'
            ? 'Backend offline'
            : live.health?.dryRun
              ? 'Dry run'
              : `BSV ${live.health?.network}`}
        </span>
      </header>
      <nav className="chapter-nav" aria-label="Walkthrough chapters">
        {chapters.map((name, i) => (
          <button
            key={name}
            aria-current={chapter === i ? 'step' : undefined}
            onClick={() => setChapter(i)}
          >
            <span>{i + 1}</span>
            {name}
          </button>
        ))}
      </nav>
      <article className="chapter" aria-labelledby="chapter-title">
        <p className="eyebrow">
          {chapter + 1} / 5 · {chapters[chapter]}
        </p>
        <h1 id="chapter-title" ref={heading} tabIndex={-1}>
          {headings[chapter]}
        </h1>

        {chapter === 0 && (
          <>
            <p className="lead">
              AI agents depend on libraries that other people build and
              maintain. Using that code usually sends its maintainers no money.
            </p>
            <div className="problem-examples" aria-label="Real-world examples">
              <section>
                <span className="small-label">curl · Maintainer workload</span>
                <h2>Time lost to false alarms.</h2>
                <p>
                  AI-generated security reports waste hours of the curl team’s
                  time and exhaust its maintainers.
                </p>
                <a href="https://daniel.haxx.se/blog/2025/07/14/death-by-a-thousand-slops/" target="_blank" rel="noopener noreferrer">
                  Maintainer’s account ↗
                </a>
              </section>
              <section>
                <span className="small-label">PHP · October 2026</span>
                <h2>Critical code needs care.</h2>
                <p>
                  PHP2Shell: two critical flaws could let attackers run code on
                  web servers. PHP released fixes on 21 October.
                </p>
                <a href="https://www.php.net/archive/2026.php" target="_blank" rel="noopener noreferrer">
                  PHP security advisory ↗
                </a>
              </section>
              <section>
                <span className="small-label">core-js · 2023</span>
                <h2>Widely used. Barely funded.</h2>
                <p>
                  The JavaScript library’s maintainer described financial
                  hardship and asked companies using his work to support it.
                </p>
                <a href="https://github.com/zloirock/core-js/blob/master/docs/2023-02-14-so-whats-next.md" target="_blank" rel="noopener noreferrer">
                  Maintainer’s account ↗
                </a>
              </section>
            </div>
            <p className="problem-solution">
              <strong>Upstream turns usage into funding.</strong> Agents pay the
              projects they use. Sponsors add a matching bonus.
            </p>
          </>
        )}

        {chapter === 1 && (
          <>
            <p className="lead">
              You approve the starting budget in BSV Desktop. Agents then use
              their own funded wallets for small payments.
            </p>
            <div
              className="money-path"
              aria-label="Funding goes from your wallet to agent wallets"
            >
              <div>
                <span className="small-label">You approve</span>
                <strong>Your BSV wallet</strong>
              </div>
              <span className="path-arrow" aria-hidden="true">
                →
              </span>
              <div>
                <span className="small-label">Agents receive</span>
                <strong>A spending budget</strong>
              </div>
            </div>
            <p className="explanation">
              The sponsor’s separate{' '}
              <strong>
                {tally ? sats(tally.pool) : '—'}-sat matching pool
              </strong>{' '}
              leaves their wallet only at the final payout.
            </p>
          </>
        )}

        {chapter === 2 && (
          <>
            <p className="lead">
              An agent’s payment goes directly to the project’s wallet. BSV
              makes it possible to send tiny amounts in separate transactions.
            </p>
            <div
              className="money-path"
              aria-label="An agent pays the project directly"
            >
              <div>
                <span className="small-label">Pays from its budget</span>
                <strong>AI agent</strong>
              </div>
              <span className="path-arrow" aria-hidden="true">
                →
              </span>
              <div>
                <span className="small-label">Receives the payment</span>
                <strong>Open-source project</strong>
              </div>
            </div>
            <p className="explanation">
              The agent integration pays before running a library tool.{' '}
              {live.settlement
                ? `This demo round recorded ${sats(live.settlement.results.contributions)} payments totalling ${sats(live.settlement.results.totalRaised)} sats.`
                : 'The demo below sends one payment per agent to the project you choose.'}
            </p>
          </>
        )}

        {chapter === 3 && (
          <>
            <p className="lead">
              A sponsor adds a pool of money. <strong>Quadratic funding</strong>{' '}
              divides it by the breadth of support, giving more weight to
              contributions spread across different owners.
            </p>
            <div className="example-heading">
              <span>Same 10 sats received. Different support.</span>
              <span className="example-label">
                Example only · no transactions
              </span>
            </div>
            <div className="matching-example">
              <div className="example-crowd">
                <span className="small-label">Project A</span>
                <h2>10 owners × 1 sat</h2>
                <div className="owner-dots" aria-hidden="true">
                  {Array.from({ length: 10 }, (_, i) => (
                    <i key={i} />
                  ))}
                </div>
                <strong>
                  {exampleMatch('crowd')}% <span>of the matching pool</span>
                </strong>
              </div>
              <div>
                <span className="small-label">Project B</span>
                <h2>1 owner × 10 sats</h2>
                <div className="owner-dots" aria-hidden="true">
                  <i className="single-owner" />
                </div>
                <strong>
                  {exampleMatch('single')}% <span>of the matching pool</span>
                </strong>
              </div>
            </div>
            <p className="explanation">
              Both keep their direct payments. A project with only one owner
              gets no match. More agents from the same owner do not increase its
              owner count.
            </p>
            <details className="explanation-details">
              <summary>How the backend calculates this</summary>
              <p>
                For each project, add up each owner’s payments. Add the square
                roots of those totals, square the sum, then subtract the direct
                funding. Divide the sponsor pool in proportion to those scores,
                rounding down to whole satoshis. Remainders stay in the
                sponsor’s wallet.
              </p>
              <p>
                Owner signatures are required. Matching counts wallet owner
                keys; it does not prove that each key belongs to a different
                person. The swarm’s owner keys are generated locally for this
                demo.
              </p>
            </details>
          </>
        )}

        {chapter === 4 && (
          <>
            <p className="lead">
              {live.settlement
                ? 'The round is settled. Here is each project’s direct funding, paid matching bonus and total.'
                : 'Each project keeps its direct contributions and receives its allocated sponsor bonus when you approve settlement.'}
            </p>
            <div className="tally-caption">
              <strong>
                {tally ? sats(tally.pool) : '—'} sats <span>sponsor pool</span>
              </strong>
              <span>
                {tally
                  ? `${sats(tally.contributions)} payments · ${sats(tally.owners)} owner keys`
                  : 'Waiting for backend data'}
              </span>
            </div>
            {live.status !== 'connected' && (
              <p className="notice">
                Backend disconnected. Displayed amounts may be stale.
              </p>
            )}
            {(tally?.dryRunContributions ?? 0) > 0 && (
              <p className="notice">
                Includes {tally?.dryRunContributions} dry-run contributions.
                Those were not broadcast.
              </p>
            )}
            <div className="scroll payout-table">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th className="num">Direct</th>
                    <th className="num">
                      {live.settlement ? '+ Paid match' : '+ Match'}
                    </th>
                    <th className="num">= Total</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => {
                    const row = tally?.rows.find(
                      (r) => r.project === project.id
                    )
                    return (
                      <tr key={project.id}>
                        <td>
                          <strong>{project.id}</strong>
                          <span>{purposes[project.id]}</span>
                        </td>
                        <td className="num">
                          {tally ? sats(row?.raised ?? 0) : '—'}
                        </td>
                        <td className="num">
                          {tally ? sats(row?.match ?? 0) : '—'}
                        </td>
                        <td className="num total">
                          {tally
                            ? sats((row?.raised ?? 0) + (row?.match ?? 0))
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {matchedProjects.length === 1 && (
              <p className="allocation-note">
                <strong>Why this split?</strong> {matchedProjects[0]!.project}{' '}
                is the only project with matching weight in this round, so it
                receives the allocated sponsor pool.
              </p>
            )}
            <p className="table-note">
              All amounts in sats.{' '}
              {live.settlement
                ? 'These are the results saved with the settlement transaction.'
                : 'Match and total show the current allocation, not proof of settlement.'}{' '}
              These five projects and their wallets belong to the demo.
            </p>
            {tally?.contributions === 0 && (
              <p className="empty-explanation">
                No payments yet. Fund the agents in step 2, then send payments
                in step 3 to see the split here.
              </p>
            )}
          </>
        )}

        {chapter === 4 && live.settlement && (
          <div className="settlement-complete">
            <div>
              <span className="small-label">Settlement recorded</span>
              <strong>
                {sats(live.settlement.results.totalMatched)} sats sent to
                projects
              </strong>
            </div>
            <a
              href={`https://whatsonchain.com/tx/${live.settlement.txid}`}
              target="_blank"
              rel="noreferrer"
            >
              View payout ↗
            </a>
          </div>
        )}
        <WalletPanel stage={stage} settled={live.settlement !== null} />

        {(chapter === 2 || chapter === 4) && (
          <details className="explanation-details receipts">
            <summary>
              View latest recorded transactions
              {live.feed.length > 0 ? ` (${live.feed.length})` : ''}
            </summary>
            {live.feed.length === 0 ? (
              <p>No contributions recorded for this round.</p>
            ) : (
              <ul className="payments">
                {live.feed.map((event) => {
                  const url = transactionUrl(event)
                  return (
                    <li key={event.id}>
                      <div>
                        <strong>{event.project}</strong>
                        <span>{event.label}</span>
                      </div>
                      <div className="receipt">
                        <strong>
                          {event.source === 'rejected'
                            ? 'Rejected'
                            : `${sats(event.sats)} ${event.sats === 1 ? 'sat' : 'sats'}`}
                        </strong>
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer">
                            View transaction ↗
                          </a>
                        ) : (
                          <span>
                            {event.reason ?? 'Dry run · not broadcast'}
                          </span>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </details>
        )}
      </article>
      <footer className="walkthrough-footer">
        <button
          className="back-button"
          onClick={() => setChapter((c) => Math.max(0, c - 1))}
          disabled={chapter === 0}
        >
          ← Back
        </button>
        <span>2–3 minute walkthrough</span>
        <button
          className="next-button"
          onClick={() => setChapter(chapter === 4 ? 0 : chapter + 1)}
        >
          {chapter === 4
            ? 'Back to the idea ↺'
            : `Next: ${chapters[chapter + 1]} →`}
        </button>
      </footer>
    </main>
  )
}
