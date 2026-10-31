export type PaymentGroup = 'lisa' | 'swarm'
export interface PaymentRun {
  id: string
  state: 'running' | 'complete' | 'failed'
  completed: number
  total: number
  txids: string[]
  error?: string
}
export interface PaymentStatus {
  live: boolean
  token: string
  satsPerPayment: number
  groups: Record<
    PaymentGroup,
    { count: number; ready: boolean; reason: string | null }
  >
  run: PaymentRun | null
}
