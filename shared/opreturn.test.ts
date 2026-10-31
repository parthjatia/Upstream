import { OP, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  contributionScript,
  decodeTag,
  encodeTag,
  findContributionTag,
  readTagFromScript
} from './opreturn.ts'

const address = (): string => PrivateKey.fromRandom().toAddress([0x00])

describe('contribution tag', () => {
  it('encodes UPSTREAM|<round>|<projectId>', () => {
    expect(encodeTag('round-1', 'tiny-tls')).toBe('UPSTREAM|round-1|tiny-tls')
  })

  it('builds OP_FALSE OP_RETURN <tag> as a provably unspendable data output', () => {
    const hex = contributionScript('round-1', 'tiny-tls')
    // 00 = OP_FALSE, 6a = OP_RETURN, 19 = push 25 bytes, then the tag.
    expect(hex.startsWith('006a19')).toBe(true)
    expect(hex).toContain(Utils.toHex(Utils.toArray('UPSTREAM|round-1|tiny-tls', 'utf8')))

    const script = Script.fromHex(hex)
    expect(script.chunks[0]!.op).toBe(OP.OP_FALSE)
    expect(script.chunks[1]!.op).toBe(OP.OP_RETURN)
    expect(readTagFromScript(script)).toEqual({ round: 'round-1', projectId: 'tiny-tls' })
  })

  it('round-trips through the script', () => {
    const script = Script.fromHex(contributionScript('round-7', 'compress-lite'))
    expect(readTagFromScript(script)).toEqual({ round: 'round-7', projectId: 'compress-lite' })
  })

  it('refuses fields that would break the encoding', () => {
    expect(() => contributionScript('round|1', 'tiny-tls')).toThrow(/must not contain/)
    expect(() => contributionScript('round-1', 'tiny|tls')).toThrow(/must not contain/)
    expect(() => contributionScript('', 'tiny-tls')).toThrow(/must not be empty/)
    expect(() => contributionScript('round-1', '')).toThrow(/must not be empty/)
  })
})

describe('decodeTag', () => {
  it('accepts a well-formed tag', () => {
    expect(decodeTag('UPSTREAM|round-1|tiny-tls')).toEqual({
      round: 'round-1',
      projectId: 'tiny-tls'
    })
  })

  it('rejects anything else', () => {
    for (const bad of [
      'DOWNSTREAM|round-1|tiny-tls',
      'UPSTREAM|round-1',
      'UPSTREAM|round-1|tiny-tls|extra',
      'UPSTREAM||tiny-tls',
      'UPSTREAM|round-1|',
      'UPSTREAM',
      '',
      'random text'
    ]) {
      expect(decodeTag(bad), bad).toBeNull()
    }
  })
})

describe('findContributionTag', () => {
  /** A contribution-shaped transaction: payment, tag, change. */
  const contributionTx = (round: string, projectId: string, projectAddress: string) => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(projectAddress), satoshis: 10 })
    tx.addOutput({ lockingScript: Script.fromHex(contributionScript(round, projectId)), satoshis: 0 })
    tx.addOutput({ lockingScript: new P2PKH().lock(address()), satoshis: 1_400 })
    return tx
  }

  it('finds the tag wherever it sits', () => {
    const tx = contributionTx('round-1', 'tiny-tls', address())
    expect(findContributionTag(tx)).toEqual({ round: 'round-1', projectId: 'tiny-tls' })
  })

  it('finds the tag at output 0 too', () => {
    const tx = new Transaction()
    tx.addOutput({
      lockingScript: Script.fromHex(contributionScript('round-1', 'log-helper')),
      satoshis: 0
    })
    tx.addOutput({ lockingScript: new P2PKH().lock(address()), satoshis: 10 })
    expect(findContributionTag(tx)?.projectId).toBe('log-helper')
  })

  it('returns null when there is no tag', () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: new P2PKH().lock(address()), satoshis: 10 })
    expect(findContributionTag(tx)).toBeNull()
  })

  it('ignores an OP_RETURN carrying something else', () => {
    const tx = new Transaction()
    tx.addOutput({
      lockingScript: new Script()
        .writeOpCode(OP.OP_FALSE)
        .writeOpCode(OP.OP_RETURN)
        .writeBin(Utils.toArray('hello world', 'utf8')),
      satoshis: 0
    })
    expect(findContributionTag(tx)).toBeNull()
  })

  it('does NOT accept a spendable script that merely contains the tag bytes', () => {
    // A P2PKH-style script with the tag pushed in is not a data output, and
    // counting it would let someone claim a contribution without burning data.
    const sneaky = new Script()
      .writeBin(Utils.toArray('UPSTREAM|round-1|tiny-tls', 'utf8'))
      .writeOpCode(OP.OP_DROP)
      .writeOpCode(OP.OP_TRUE)
    expect(readTagFromScript(sneaky)).toBeNull()

    const tx = new Transaction()
    tx.addOutput({ lockingScript: sneaky, satoshis: 10 })
    expect(findContributionTag(tx)).toBeNull()
  })

  it('requires OP_FALSE before OP_RETURN', () => {
    const bare = new Script()
      .writeOpCode(OP.OP_RETURN)
      .writeBin(Utils.toArray('UPSTREAM|round-1|tiny-tls', 'utf8'))
    expect(readTagFromScript(bare)).toBeNull()
  })

  it('tolerates extra data pushes after the tag', () => {
    // Later rounds may add fields; the tag must still be readable.
    const script = new Script()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_RETURN)
      .writeBin(Utils.toArray('UPSTREAM|round-2|color-text', 'utf8'))
      .writeBin(Utils.toArray('future field', 'utf8'))
    expect(readTagFromScript(script)).toEqual({ round: 'round-2', projectId: 'color-text' })
  })

  it('skips a leading push that is not a tag', () => {
    const script = new Script()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_RETURN)
      .writeBin(Utils.toArray('noise', 'utf8'))
      .writeBin(Utils.toArray('UPSTREAM|round-1|stream-utils', 'utf8'))
    expect(readTagFromScript(script)?.projectId).toBe('stream-utils')
  })

  it('survives a non-UTF8 push without throwing', () => {
    const script = new Script()
      .writeOpCode(OP.OP_FALSE)
      .writeOpCode(OP.OP_RETURN)
      .writeBin([0xff, 0xfe, 0xfd])
    expect(() => readTagFromScript(script)).not.toThrow()
  })
})
