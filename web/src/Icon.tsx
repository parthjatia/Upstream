export type IconName =
  | 'arrow'
  | 'play'
  | 'pause'
  | 'reset'
  | 'wallet'
  | 'close'
  | 'external'
  | 'code'
  | 'shield'
  | 'stream'
  | 'log'
  | 'color'
  | 'compress'
  | 'people'
  | 'check'
  | 'expand'
  | 'info'
  | 'github'
const paths: Record<IconName, string> = {
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  play: 'm9 5 11 7-11 7Z',
  pause: 'M9 5v14M15 5v14',
  reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
  wallet: 'M20 8V5H4v14h16V8H4m16 4h-5v4h5',
  close: 'm6 6 12 12M6 18 18 6',
  external: 'M14 4h6v6m0-6L10 14m0-9H4v15h15v-6',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
  stream: 'M3 7h12m-4-4 4 4-4 4M21 17H9m4-4-4 4 4 4',
  log: 'M5 4h14v16H5ZM8 8h8M8 12h8M8 16h4',
  color: 'm12 3 9 9-9 9-9-9Zm0 0v18m-9-9h18',
  compress: 'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5',
  people:
    'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9v-2a7 7 0 0 1 14 0v2m1-16a4 4 0 0 1 0 8m2 3c2 1 3 3 3 5',
  check: 'm5 12 4 4L19 6',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  info: 'M12 11v6m0-11v1m0-5a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  github:
    'M9 19c-5 2-5-3-7-3m14 6v-4c0-1-.3-2-1-2 4-.5 7-2 7-6 0-2-1-3-2-4 0-1 0-3-1-4-2 0-3 1-4 2a14 14 0 0 0-6 0C8 3 7 2 5 2 4 3 4 5 4 6c-1 1-2 2-2 4 0 4 3 5.5 7 6-.7 0-1 1-1 2v4'
}
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
