import { afterEach, expect, it, vi } from 'vitest'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import { broadcastToArcade } from './lib/contribute'
import { loadRuntime } from '@upstream/shared/runtime'

afterEach(() => vi.restoreAllMocks())
const transaction = () => {
  const tx = new Transaction()
  tx.addOutput({
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress([0])),
    satoshis: 10
  })
  return tx
}
it('posts to the Arcade /tx endpoint and checks the acknowledged transaction', async () => {
  const tx = transaction()
  const request = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        JSON.stringify({ txid: tx.id('hex'), txStatus: 'SEEN_ON_NETWORK' }),
        { status: 200 }
      )
    )
  await broadcastToArcade(tx, loadRuntime({ DRY_RUN: 'false' }))
  expect(request.mock.calls[0]![0]).toBe(
    'https://arcade-v2-us-1.bsvblockchain.tech/tx'
  )
  expect(request.mock.calls[0]![1]?.method).toBe('POST')
})
it.each([
  { txid: 'f'.repeat(64), txStatus: 'SEEN_ON_NETWORK' },
  { txStatus: 'REJECTED', extraInfo: 'Fee too low' },
  { txStatus: 'UNKNOWN_STATUS' }
])(
  'rejects an HTTP 200 that does not acknowledge this transaction: %j',
  async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 })
    )
    await expect(
      broadcastToArcade(transaction(), loadRuntime({ DRY_RUN: 'false' }))
    ).rejects.toThrow('Arcade refused')
  }
)
