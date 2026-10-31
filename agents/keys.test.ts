import { existsSync } from 'node:fs'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { PROJECTS } from '@upstream/shared/projects'
import { loadBudget } from '@upstream/shared/budget'
import {
  KEYS_DIR,
  MAINNET_ADDRESS_PREFIX,
  loadKeys,
  privateKeyOf,
  type KeyRecord
} from './lib/keystore.ts'

const budget = loadBudget(process.env)

const generated = ['projects', 'lisa', 'swarm', 'whale', 'sybil'].every(n =>
  existsSync(`${KEYS_DIR}/${n}.json`)
)

// keys/ is gitignored, so a fresh clone has none until `npm run keys` runs.
describe.skipIf(!generated)('key store (keys/*.json)', () => {
  const keys = generated ? loadKeys() : null!

  const everyKey = (): KeyRecord[] => [
    ...keys.projects,
    keys.lisa,
    ...keys.swarm.flatMap(s => [s.agent, s.owner]),
    keys.whale.agent,
    keys.whale.owner,
    ...keys.sybil
  ]

  it('generates the counts the budget asks for', () => {
    expect(keys.projects).toHaveLength(5)
    expect(keys.swarm).toHaveLength(budget.swarmSize)
    expect(keys.sybil).toHaveLength(budget.sybilSize)
    expect(keys.lisa.label).toBe('lisa-agent')
    expect(keys.whale.agent.label).toBe('whale-agent')
    expect(keys.whale.owner.label).toBe('whale-owner')
    // 5 projects + lisa + swarm agents + swarm owners + whale pair + sybils
    expect(everyKey()).toHaveLength(5 + 1 + budget.swarmSize * 2 + 2 + budget.sybilSize)
  })

  it('gives every swarm agent its own distinct owner', () => {
    const owners = new Set(keys.swarm.map(s => s.owner.privHex))
    expect(owners.size).toBe(budget.swarmSize)
    for (const s of keys.swarm) expect(s.agent.privHex).not.toBe(s.owner.privHex)
  })

  it('leaves sybil agents unvouched (no owner key exists for them)', () => {
    for (const s of keys.sybil) expect(s.label).toMatch(/^sybil-agent-\d{3}$/)
  })

  it('round-trips privHex -> pubKey -> address, and privHex <-> WIF', () => {
    for (const r of everyKey()) {
      const priv = privateKeyOf(r)
      expect(r.privHex, r.label).toMatch(/^[0-9a-f]{64}$/)
      expect(priv.toPublicKey().toString(), r.label).toBe(r.pubKey)
      expect(priv.toAddress(MAINNET_ADDRESS_PREFIX), r.label).toBe(r.address)
      expect(PrivateKey.fromWif(r.wif).toHex(), r.label).toBe(r.privHex)
    }
  })

  it('produces mainnet addresses, not testnet ones', () => {
    for (const r of everyKey()) {
      // Mainnet P2PKH starts with 1; testnet would start with m or n.
      expect(r.address, r.label).toMatch(/^1/)
      expect(r.address, r.label).not.toMatch(/^[mn2]/)
      // WIF for a compressed mainnet key starts with K or L (testnet: c).
      expect(r.wif, r.label).toMatch(/^[KL]/)
    }
  })

  it('never repeats a private key', () => {
    const all = everyKey()
    expect(new Set(all.map(r => r.privHex)).size).toBe(all.length)
    expect(new Set(all.map(r => r.address)).size).toBe(all.length)
  })

  it('agrees with the addresses written into shared/projects.json', () => {
    expect(keys.projects).toHaveLength(PROJECTS.length)
    for (const [i, p] of PROJECTS.entries()) {
      const key = keys.projects[i]!
      expect(key.label).toBe(p.id)
      expect(key.address).toBe(p.address)
      // The project can actually be paid: its key signs for that lock.
      expect(new P2PKH().lock(p.address).toHex()).toBe(
        new P2PKH().lock(privateKeyOf(key).toAddress(MAINNET_ADDRESS_PREFIX)).toHex()
      )
    }
  })
})
