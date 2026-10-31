/**
 * Test fixture, not part of the demo.
 *
 * A separate process that hammers one agent's UTXO record, so the concurrency
 * test can prove two processes writing at the same time do not clobber each
 * other. Run as:
 *
 *   tsx agents/lib/utxoWriter.fixture.ts <agentLabel> <iterations> <startSats>
 *
 * with UPSTREAM_DATA_DIR pointing at a scratch directory. Each iteration reads
 * the agent's own record and writes it back one satoshi lower, exactly like a
 * contribution chaining its change.
 */
import { getUtxo, putUtxo, type AgentUtxo } from './utxos.ts'

const agent = process.argv[2]
const iterations = Number(process.argv[3] ?? '50')
const startSats = Number(process.argv[4] ?? '10000')

if (agent === undefined || agent === '') {
  console.error('usage: utxoWriter.fixture.ts <agentLabel> <iterations> <startSats>')
  process.exit(2)
}

const seed: AgentUtxo = {
  agent,
  txid: 'a'.repeat(64),
  vout: 0,
  satoshis: startSats,
  lockingScriptHex: '76a914' + '00'.repeat(20) + '88ac',
  sourceTxHex: '',
  synthetic: true,
  origin: 'synthetic',
  updatedAt: new Date().toISOString()
}
putUtxo(seed)

for (let i = 0; i < iterations; i++) {
  const current = getUtxo(agent)
  if (current === undefined) {
    console.error(`${agent} lost its record at iteration ${i}`)
    process.exit(1)
  }
  putUtxo({
    ...current,
    satoshis: current.satoshis - 1,
    vout: i,
    updatedAt: new Date().toISOString()
  })
}

const final = getUtxo(agent)
console.log(JSON.stringify({ agent, satoshis: final?.satoshis, vout: final?.vout }))
