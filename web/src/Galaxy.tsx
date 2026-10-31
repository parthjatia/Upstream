import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { QuadraticRow } from '@upstream/shared/quadratic'
import { Icon, type IconName } from './Icon'
import type { Activity } from './dashboardModel'

export const projectVisuals: Record<
  string,
  { icon: IconName; color: string; category: string; x: number; y: number }
> = {
  'tiny-tls': {
    icon: 'shield',
    color: '#4972c5',
    category: 'Security',
    x: 432,
    y: 100
  },
  'stream-utils': {
    icon: 'stream',
    color: '#3368e8',
    category: 'Data utilities',
    x: 635,
    y: 145
  },
  'log-helper': {
    icon: 'log',
    color: '#9b75ba',
    category: 'Logging',
    x: 790,
    y: 280
  },
  'color-text': {
    icon: 'color',
    color: '#bf8050',
    category: 'Developer tools',
    x: 405,
    y: 325
  },
  'compress-lite': {
    icon: 'compress',
    color: '#399a8a',
    category: 'Compression',
    x: 610,
    y: 355
  }
}
const sourceY = { lisa: 105, swarm: 225, whale: 345, rejected: 225 }
export function Galaxy({
  rows,
  feed,
  selected,
  onSelect,
  running,
  demo
}: {
  rows: QuadraticRow[]
  feed: Activity[]
  selected: string | null
  onSelect: (id: string) => void
  running: boolean
  demo: boolean
}) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia('(max-width: 600px)').matches
  )
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const positions: Record<string, [number, number]> = {
    'tiny-tls': [103, 170],
    'stream-utils': [315, 178],
    'log-helper': [338, 355],
    'color-text': [92, 345],
    'compress-lite': [215, 465]
  }
  const visuals = Object.fromEntries(
    Object.entries(projectVisuals).map(([id, v]) => [
      id,
      mobile ? { ...v, x: positions[id]![0], y: positions[id]![1] } : v
    ])
  )
  const curve = (source: number, x: number, y: number) =>
    mobile
      ? `M ${[75, 215, 355][source]} 78 C ${[75, 215, 355][source]} 130, ${x} ${y - 80}, ${x} ${y}`
      : `M 166 ${[105, 225, 345][source]} C 280 ${[105, 225, 345][source]}, ${x - 140} ${y}, ${x} ${y}`
  const max = Math.max(1, ...rows.map((r) => r.match))
  return (
    <div className={`galaxy ${running ? 'is-running' : ''}`}>
      <div className="map-column-label map-label-agents">
        {demo ? 'AI agents' : 'Contributors'}
      </div>
      <div className="map-column-label map-label-projects">
        Open-source projects
      </div>
      <svg
        viewBox={mobile ? '0 0 430 580' : '0 0 900 470'}
        className="network-map"
        role="group"
        aria-label="Funding map. Select a project to inspect its funding."
      >
        <defs>
          <pattern
            id="dot-grid"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r=".7" fill="#ccd5df" />
          </pattern>
          <radialGradient id="map-halo">
            <stop stopColor="#e7efff" stopOpacity=".9" />
            <stop offset="1" stopColor="#f8fafc" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect
          width={mobile ? 430 : 900}
          height={mobile ? 580 : 470}
          fill="url(#dot-grid)"
        />
        <ellipse cx="590" cy="230" rx="310" ry="220" fill="url(#map-halo)" />
        {Object.entries(visuals).map(([id, v]) => (
          <g key={id}>
            {(demo ? [0, 1, 2] : [1]).map((i) => (
              <path
                key={i}
                d={curve(i, v.x, v.y)}
                fill="none"
                stroke={selected === id ? v.color : '#d7e0ed'}
                strokeWidth={selected === id ? 1.4 : 1}
                opacity={i === 1 ? 0.8 : 0.45}
              />
            ))}
          </g>
        ))}
        {(demo ? [105, 225, 345] : [225]).map((y, i) => (
          <g
            key={y}
            transform={
              mobile
                ? `translate(${demo ? [25, 165, 305][i] : 165} 24)`
                : `translate(65 ${y - 27})`
            }
          >
            <rect
              width="100"
              height="54"
              rx="12"
              fill="white"
              stroke="#dce3ee"
            />
            <circle
              cx="23"
              cy="27"
              r="12"
              fill={
                i === 0 && demo ? '#fbf2df' : i === 2 ? '#e6edfb' : '#eaf0fb'
              }
            />
            <g
              transform="translate(15 19)"
              color={i === 0 && demo ? '#b28b3e' : '#4f72ab'}
            >
              <Icon name={i === 2 ? 'wallet' : 'code'} size={16} />
            </g>
            <text x="43" y="31" className="source-label">
              {demo ? ['Lisa', 'Swarm', 'Whale'][i] : 'Agents'}
            </text>
            {i === 1 && (
              <>
                {Array.from({ length: 9 }, (_, n) => (
                  <circle
                    key={n}
                    cx={10 + n * 10}
                    cy="68"
                    r="2"
                    fill="#93abd2"
                  />
                ))}
              </>
            )}
          </g>
        ))}
        {feed.slice(0, 12).map((event) => {
          const v = visuals[event.project]
          if (!v) return null
          const y = demo ? sourceY[event.source] : 225
          const rejected = event.source === 'rejected'
          const path = mobile
            ? curve(
                demo
                  ? event.source === 'lisa'
                    ? 0
                    : event.source === 'whale'
                      ? 2
                      : 1
                  : 1,
                rejected ? 215 : v.x,
                rejected ? 115 : v.y
              )
            : rejected
              ? `M166 ${y} C250 ${y},300 ${v.y},330 ${v.y} L290 ${v.y + 30}`
              : `M166 ${y} C280 ${y},${v.x - 140} ${v.y},${v.x} ${v.y}`
          return (
            <PaymentParticle
              key={event.id}
              path={path}
              source={event.source}
              color={
                rejected
                  ? '#cf5f64'
                  : event.source === 'lisa'
                    ? '#c49a45'
                    : v.color
              }
            />
          )
        })}
        {Object.entries(visuals).map(([id, v]) => {
          const row = rows.find((r) => r.project === id)
          const radius = 27 + Math.sqrt((row?.match ?? 0) / max) * 23
          return (
            <g
              key={id}
              className={`project-node ${selected === id ? 'selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${id}, ${row?.supporters ?? 0} supporters, ${row?.match ?? 0} matching satoshis. View details.`}
              aria-pressed={selected === id}
              onClick={() => onSelect(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(id)
                }
              }}
              transform={`translate(${v.x} ${v.y})`}
              style={{ '--node-color': v.color } as CSSProperties}
            >
              <circle
                className="node-orbit"
                r={radius + 12}
                fill="none"
                stroke={v.color}
                strokeOpacity=".12"
              />
              <circle
                className="node-fill"
                r={radius}
                fill="white"
                stroke={v.color}
                strokeOpacity=".3"
              />
              <circle r={radius - 6} fill={v.color} opacity=".045" />
              <g transform="translate(-13 -13)" color={v.color}>
                <Icon name={v.icon} size={26} />
              </g>
              <text y={radius + 32} textAnchor="middle" className="node-name">
                {id}
              </text>
              <text y={radius + 50} textAnchor="middle" className="node-value">
                {(row?.match ?? 0).toLocaleString('en-US')} sats matched
              </text>
            </g>
          )
        })}
      </svg>
      <div className="map-legend">
        {demo && (
          <span>
            <i className="legend-dot gold" />
            Lisa
          </span>
        )}
        <span>
          <i className="legend-dot blue" />
          Agent payment
        </span>
        <span>
          <i className="legend-dot red" />
          Rejected
        </span>
        <span className="legend-size">
          <span>◯</span> Circle size = matching share
        </span>
      </div>
    </div>
  )
}

// Begin relative to event arrival, not the SVG document's original time zero.
function PaymentParticle({
  path,
  source,
  color
}: {
  path: string
  source: Activity['source']
  color: string
}) {
  const ref = useRef<SVGGElement>(null)
  useEffect(() => {
    ref.current
      ?.querySelectorAll<SVGAnimationElement>('animateMotion')
      .forEach((animation) => animation.beginElement())
  }, [])
  return (
    <g
      ref={ref}
      className="payment-particle"
      style={{ '--particle-color': color } as CSSProperties}
    >
      <circle r={source === 'whale' ? 7 : 4} fill="currentColor">
        <animateMotion
          begin="indefinite"
          dur="1.9s"
          path={path}
          fill="freeze"
        />
      </circle>
      <circle r="11" fill="currentColor" opacity=".15">
        <animateMotion
          begin="indefinite"
          dur="1.9s"
          path={path}
          fill="freeze"
        />
      </circle>
    </g>
  )
}
