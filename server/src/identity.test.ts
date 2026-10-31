import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { signAgentAttestation, type AgentAttestation } from '@upstream/shared/attestation'

let dir: string

// Point the store at a temp directory so the suite never touches a real round.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'upstream-identity-'))
  process.env.UPSTREAM_DATA_DIR = dir
})
afterAll(() => {
  delete process.env.UPSTREAM_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

const { AttestationError, allAttestations, findAttestation, saveAttestation } = await import(
  './identity.ts'
)
const { writeJson, dataPath } = await import('./store.ts')

const wallet = () => new ProtoWallet(PrivateKey.fromRandom())
const agentPubKey = () => PrivateKey.fromRandom().toPublicKey().toString()

beforeEach(() => {
  writeJson(dataPath('attestations.json'), [])
})

describe('attestation store', () => {
  it('verifies and stores a good attestation', async () => {
    const att = await signAgentAttestation(wallet(), agentPubKey())
    const stored = await saveAttestation('lisa-agent', att)

    expect(stored.verified).toBe(true)
    expect(stored.label).toBe('lisa-agent')
    expect(stored.ownerPubKey).toBe(att.ownerPubKey)
    expect(allAttestations()).toHaveLength(1)
    expect(findAttestation(att.agentPubKey)?.ownerPubKey).toBe(att.ownerPubKey)
  })

  it('refuses a signature that does not verify, and stores nothing', async () => {
    const att = await signAgentAttestation(wallet(), agentPubKey())
    const other = await wallet().getPublicKey({ identityKey: true })
    const bad: AgentAttestation = { ...att, ownerPubKey: other.publicKey }

    await expect(saveAttestation('lisa-agent', bad)).rejects.toThrow(/does not verify/)
    await expect(saveAttestation('lisa-agent', bad)).rejects.toMatchObject({ status: 400 })
    expect(allAttestations()).toHaveLength(0)
  })

  it('does not let a bad attestation displace a good one', async () => {
    const good = await signAgentAttestation(wallet(), agentPubKey())
    await saveAttestation('lisa-agent', good)

    const impostor = await wallet().getPublicKey({ identityKey: true })
    await expect(
      saveAttestation('lisa-agent', { ...good, ownerPubKey: impostor.publicKey })
    ).rejects.toThrow()

    // Lisa still owns her agent.
    expect(findAttestation(good.agentPubKey)?.ownerPubKey).toBe(good.ownerPubKey)
    expect(allAttestations()).toHaveLength(1)
  })

  it('refuses to re-assign an agent to a different owner, even with a valid signature', async () => {
    const agent = agentPubKey()
    const lisa = await signAgentAttestation(wallet(), agent)
    await saveAttestation('lisa-agent', lisa)

    // A genuine signature from someone else over the same agent key: valid
    // crypto, but it would hand them Lisa's matching weight.
    const attacker = await signAgentAttestation(wallet(), agent)
    await expect(saveAttestation('lisa-agent', attacker)).rejects.toThrow(/one owner/)
    await expect(saveAttestation('lisa-agent', attacker)).rejects.toMatchObject({ status: 409 })

    expect(findAttestation(agent)?.ownerPubKey).toBe(lisa.ownerPubKey)
  })

  it('is idempotent when the same owner signs again', async () => {
    const agent = agentPubKey()
    const owner = wallet()
    await saveAttestation('lisa-agent', await signAgentAttestation(owner, agent))
    await saveAttestation('lisa-agent', await signAgentAttestation(owner, agent))

    expect(allAttestations()).toHaveLength(1)
  })

  it('keeps attestations for different agents side by side', async () => {
    const owner = wallet()
    await saveAttestation('swarm-agent-001', await signAgentAttestation(owner, agentPubKey()))
    await saveAttestation('swarm-agent-002', await signAgentAttestation(owner, agentPubKey()))

    expect(allAttestations()).toHaveLength(2)
    expect(allAttestations().every(a => a.verified)).toBe(true)
  })

  it('reports the right HTTP status on its errors', () => {
    expect(new AttestationError('x', 400).status).toBe(400)
    expect(new AttestationError('x', 409).status).toBe(409)
  })
})
