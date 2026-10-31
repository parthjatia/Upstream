/**
 * Phase 1: an empty shell that proves the web app builds, loads `@upstream/shared`
 * and can reach the server. The real screens arrive later:
 *  - Phase 3 "Fund agents" (BSV Desktop via WalletClient)
 *  - Phase 8 the funding galaxy and sponsor panel
 *  - Phase 9 "Settle round"
 */
import { useEffect, useState } from 'react'
import { DEFAULT_ROUND } from '@upstream/shared'

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8787'

export function App() {
  const [server, setServer] = useState('checking…')

  useEffect(() => {
    fetch(`${SERVER_URL}/health`)
      .then(r => r.json())
      .then((h: { service: string; round: string; network: string }) => {
        setServer(`${h.service} up · round ${h.round} · ${h.network}`)
      })
      .catch(() => setServer(`no server at ${SERVER_URL} — run \`npm run server\``))
  }, [])

  return (
    <main>
      <h1>Upstream</h1>
      <p className="tagline">
        AI agents pay the open-source projects they use. A sponsor pool is split by quadratic
        funding, so many independent supporters beat one whale. Everything settles on BSV.
      </p>
      <dl>
        <dt>Round</dt>
        <dd>{DEFAULT_ROUND}</dd>
        <dt>Server</dt>
        <dd>{server}</dd>
        <dt>Phase</dt>
        <dd>1 — scaffold</dd>
      </dl>
    </main>
  )
}
