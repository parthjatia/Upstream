import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  AGENT_ATTESTATION_KEY_ID,
  AGENT_ATTESTATION_PROTOCOL,
  agentAttestationData,
  signAgentAttestation,
  verifyAgentAttestation
} from './attestation.ts'

/** A simulated owner, as the swarm will use in Phase 7. */
const owner = () => new ProtoWallet(PrivateKey.fromRandom())
const agentPubKey = () => PrivateKey.fromRandom().toPublicKey().toString()

describe('agent attestation', () => {
  it('uses a security level that makes the wallet ask', () => {
    // Level 0 would never prompt the user, which is wrong for a key that
    // decides who gets matched. BRC-43 also wants a name of 5+ characters.
    expect(AGENT_ATTESTATION_PROTOCOL[0]).toBeGreaterThanOrEqual(1)
    expect(AGENT_ATTESTATION_PROTOCOL[1].length).toBeGreaterThanOrEqual(5)
    expect(AGENT_ATTESTATION_PROTOCOL[1]).toMatch(/^[a-zA-Z0-9 ]+$/)
  })

  it('signs the agent public key itself', () => {
    const pub = agentPubKey()
    expect(agentAttestationData(pub)).toEqual(Utils.toArray(pub, 'hex'))
    expect(agentAttestationData(pub)).toHaveLength(33) // compressed key
  })

  it('round-trips: an owner vouches, anyone can verify', async () => {
    const att = await signAgentAttestation(owner(), agentPubKey())
    await expect(verifyAgentAttestation(att)).resolves.toBe(true)
    expect(att.signature).toMatch(/^[0-9a-f]+$/)
  })

  it('rejects an attestation for a different agent', async () => {
    const att = await signAgentAttestation(owner(), agentPubKey())
    const swapped = { ...att, agentPubKey: agentPubKey() }
    await expect(verifyAgentAttestation(swapped)).resolves.toBe(false)
  })

  it('rejects an attestation claimed by the wrong owner', async () => {
    const att = await signAgentAttestation(owner(), agentPubKey())
    const impostor = await owner().getPublicKey({ identityKey: true })
    await expect(
      verifyAgentAttestation({ ...att, ownerPubKey: impostor.publicKey })
    ).resolves.toBe(false)
  })

  it('rejects a tampered signature', async () => {
    const att = await signAgentAttestation(owner(), agentPubKey())
    const flipped = att.signature.slice(0, -2) + (att.signature.endsWith('00') ? '01' : '00')
    await expect(verifyAgentAttestation({ ...att, signature: flipped })).resolves.toBe(false)
  })

  it('returns false rather than throwing on malformed input', async () => {
    await expect(
      verifyAgentAttestation({ ownerPubKey: 'nope', agentPubKey: 'nope', signature: 'nope' })
    ).resolves.toBe(false)
    await expect(
      verifyAgentAttestation({ ownerPubKey: '', agentPubKey: '', signature: '' })
    ).resolves.toBe(false)
  })

  it('an agent cannot vouch for itself without its owner', async () => {
    // The agent key signing its own public key does not produce an attestation
    // that verifies against the owner's identity key.
    const agentKey = PrivateKey.fromRandom()
    const att = await signAgentAttestation(
      new ProtoWallet(agentKey),
      agentKey.toPublicKey().toString()
    )
    const realOwner = await owner().getPublicKey({ identityKey: true })
    await expect(
      verifyAgentAttestation({ ...att, ownerPubKey: realOwner.publicKey })
    ).resolves.toBe(false)
  })

  it('keeps the keyID stable, so Phase 5 verifies what Phase 3 signed', () => {
    expect(AGENT_ATTESTATION_KEY_ID).toBe('agent')
  })
})
