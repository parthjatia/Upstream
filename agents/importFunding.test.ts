/**
 * The output-matching logic `import-funding` relies on.
 *
 * Matching is by locking script, never by position: a manual Send from a wallet
 * puts change and other outputs wherever it likes, so an agent's output could
 * be at any index.
 */
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import type { KeyRecord } from '@upstream/shared/keystore'

const key = (label: string): KeyRecord => {
  const priv = PrivateKey.fromRandom()
  return {
    label,
    privHex: priv.toHex(),
    wif: priv.toWif([0x80]),
    pubKey: priv.toPublicKey().toString(),
    address: priv.toAddress([0x00])
  }
}

/** The same matching import-funding performs, isolated for testing. */
function matchOutputs(
  tx: Transaction,
  agents: KeyRecord[]
): Array<{ agent: string; vout: number; satoshis: number }> {
  const byScript = new Map(agents.map(a => [new P2PKH().lock(a.address).toHex(), a]))
  const found: Array<{ agent: string; vout: number; satoshis: number }> = []
  for (const [vout, output] of tx.outputs.entries()) {
    const agent = byScript.get(output.lockingScript.toHex())
    if (agent === undefined) continue
    found.push({ agent: agent.label, vout, satoshis: output.satoshis ?? 0 })
  }
  return found
}

describe('import-funding output matching', () => {
  const agents = [key('lisa-agent'), key('swarm-agent-001'), key('whale-agent')]

  it('finds agent outputs wherever the wallet put them', () => {
    const stranger = key('not-ours')
    const tx = new Transaction()
    // A manual Send: an unrelated output, then ours, then change.
    tx.addOutput({ lockingScript: new P2PKH().lock(stranger.address), satoshis: 999 })
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[1]!.address), satoshis: 1_500 })
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[0]!.address), satoshis: 5_000 })
    tx.addOutput({ lockingScript: new P2PKH().lock(stranger.address), satoshis: 4_242 })

    expect(matchOutputs(tx, agents)).toEqual([
      { agent: 'swarm-agent-001', vout: 1, satoshis: 1_500 },
      { agent: 'lisa-agent', vout: 2, satoshis: 5_000 }
    ])
  })

  it('ignores a transaction that pays none of our agents', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(key('stranger').address), satoshis: 10_000 })
    expect(matchOutputs(tx, agents)).toEqual([])
  })

  it('records the real amount paid, not the amount expected', () => {
    // A manual Send may not match the budget; what landed is what we can spend.
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[0]!.address), satoshis: 1_234 })
    expect(matchOutputs(tx, agents)[0]!.satoshis).toBe(1_234)
  })

  it('finds several outputs paying the same agent', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[0]!.address), satoshis: 100 })
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[0]!.address), satoshis: 200 })
    const found = matchOutputs(tx, agents)
    expect(found).toHaveLength(2)
    // import-funding keeps the last, since one output per agent is spendable.
    expect(found.map(f => f.vout)).toEqual([0, 1])
  })

  it('skips an OP_RETURN data output without matching or throwing', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: Script.fromHex('006a0b68656c6c6f20776f726c64'), satoshis: 0 })
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[0]!.address), satoshis: 5_000 })
    expect(matchOutputs(tx, agents)).toEqual([{ agent: 'lisa-agent', vout: 1, satoshis: 5_000 }])
  })

  it('round-trips a transaction through hex without losing a match', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(agents[2]!.address), satoshis: 20_000 })
    const reparsed = Transaction.fromHex(tx.toHex())
    expect(matchOutputs(reparsed, agents)).toEqual([
      { agent: 'whale-agent', vout: 0, satoshis: 20_000 }
    ])
  })
})
