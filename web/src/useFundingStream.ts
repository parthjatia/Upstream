import { useEffect, useState } from 'react'
import { parseResults, type RoundResults } from '@upstream/shared/settlement'
import type { UpstreamEvent } from '@upstream/shared'
import type { StoredContribution, Tally } from '../../server/src/contributions'
import { BASE, call, getHealth, type Health } from './api'
import type { Activity } from './dashboardModel'

export function useFundingStream(enabled: boolean) {
  const [tally, setTally] = useState<Tally | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [feed, setFeed] = useState<Activity[]>([])
  const [status, setStatus] = useState<'connecting' | 'connected' | 'offline'>(
    'connecting'
  )
  const [settlement, setSettlement] = useState<{
    txid: string
    results: RoundResults
  } | null>(null)
  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    let running = false
    let streamOpen = false
    let queued = false
    setTally(null)
    setHealth(null)
    setFeed([])
    setSettled(null)
    setSettlement(null)
    setStatus('connecting')
    // Reconcile the authoritative totals instead of incrementing SSE replays.
    const refresh = async () => {
      if (running) {
        queued = true
        return
      }
      running = true
      try {
        const [t, h, history, settlements] = await Promise.all([
          call<Tally>('/tally'),
          getHealth(),
          call<{ contributions: StoredContribution[] }>('/contribution'),
          call<Array<{ round: string; txid: string; resultsJson: string }>>(
            '/settlement'
          )
        ])
        if (active) {
          setTally(t)
          setHealth(h)
          const record = settlements.find((s) => s.round === t.round)
          setSettlement(
            record
              ? { txid: record.txid, results: parseResults(record.resultsJson) }
              : null
          )
          setSettled(record?.txid ?? null)
          const receipts: Activity[] = history.contributions
            .filter((c) => c.round === t.round)
            .slice(-30)
            .reverse()
            .map((c) => ({
              id: `contribution-${c.txid}`,
              project: c.project,
              label: `Owner ${c.owner.slice(0, 6)}…`,
              source: 'swarm',
              sats: c.sats,
              dryRun: c.dryRun !== false,
              txid: c.txid
            }))
          setFeed((previous) =>
            [
              ...receipts,
              ...previous.filter((e) => e.source === 'rejected')
            ].slice(0, 30)
          )
          if (streamOpen) setStatus('connected')
        }
      } catch {
        if (active) setStatus('offline')
      } finally {
        running = false
        if (queued && active) {
          queued = false
          void refresh()
        }
      }
    }
    void refresh()
    const stream = new EventSource(`${BASE}/events`)
    stream.onopen = () => {
      if (active) {
        streamOpen = true
        void refresh()
      }
    }
    stream.onerror = () => {
      streamOpen = false
      if (active) setStatus('offline')
    }
    const receive = (message: MessageEvent<string>) => {
      if (!active) return
      try {
        const event = JSON.parse(message.data) as UpstreamEvent
        if (event.type === 'contribution' || event.type === 'rejected') {
          const rejected = event.type === 'rejected'
          const item: Activity = {
            id: `${event.type}-${event.txid ?? event.project + ('reason' in event ? event.reason : '')}`,
            project: event.project,
            label: rejected
              ? 'Rejected contribution'
              : `Owner ${event.owner.slice(0, 6)}…`,
            source: rejected ? 'rejected' : 'swarm',
            sats: rejected ? 0 : event.sats,
            dryRun: rejected || event.dryRun !== false,
            txid: event.txid,
            ...(rejected ? { reason: event.reason } : {})
          }
          setFeed((previous) =>
            previous.some((e) => e.id === item.id)
              ? previous
              : [item, ...previous].slice(0, 30)
          )
        }
        if (event.type === 'settled' && /^[a-f0-9]{64}$/i.test(event.txid))
          setSettled(event.txid)
        void refresh()
      } catch {
        /* An incomplete event never changes the displayed tally. */
      }
    }
    for (const type of ['contribution', 'rejected', 'tally', 'settled'])
      stream.addEventListener(type, receive as EventListener)
    const poll = window.setInterval(() => void refresh(), 10000)
    return () => {
      active = false
      stream.close()
      window.clearInterval(poll)
    }
  }, [enabled])
  return { tally, health, feed, status, settled, settlement }
}
