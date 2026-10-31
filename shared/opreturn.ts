/**
 * The contribution tag: `UPSTREAM|<round>|<projectId>` in an OP_RETURN.
 *
 * Every contribution carries one, so the round is auditable from the chain
 * alone: anyone can scan a transaction and see which project was being paid
 * and in which round, without trusting our server.
 *
 * Format follows the guide §12: `OP_FALSE OP_RETURN <data>` is a provably
 * unspendable 0-satoshi output, and `writeBin` picks the minimal push encoding.
 * The whole tag is one UTF-8 push, as PROJECT_BRIEF.md specifies.
 */
import { OP, Script, Utils, type Transaction } from '@bsv/sdk'

export const TAG_PREFIX = 'UPSTREAM'
export const TAG_SEPARATOR = '|'

/** A decoded contribution tag. */
export interface ContributionTag {
  round: string
  projectId: string
}

/** `UPSTREAM|round-1|tiny-tls` */
export const encodeTag = (round: string, projectId: string): string =>
  [TAG_PREFIX, round, projectId].join(TAG_SEPARATOR)

/**
 * Build the OP_RETURN locking script for a contribution.
 *
 * Reject separators in the fields rather than emit a tag that cannot be
 * decoded back to the same values.
 */
export function contributionScript(round: string, projectId: string): string {
  for (const [name, value] of [
    ['round', round],
    ['projectId', projectId]
  ] as const) {
    if (value.length === 0) throw new Error(`${name} must not be empty`)
    if (value.includes(TAG_SEPARATOR)) {
      throw new Error(`${name} must not contain "${TAG_SEPARATOR}": ${value}`)
    }
  }
  return new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(encodeTag(round, projectId), 'utf8'))
    .toHex()
}

/** Parse `UPSTREAM|<round>|<projectId>`. Returns null for anything else. */
export function decodeTag(text: string): ContributionTag | null {
  const parts = text.split(TAG_SEPARATOR)
  if (parts.length !== 3) return null
  const [prefix, round, projectId] = parts
  if (prefix !== TAG_PREFIX) return null
  if (round === undefined || round.length === 0) return null
  if (projectId === undefined || projectId.length === 0) return null
  return { round, projectId }
}

/**
 * Find the contribution tag in a transaction.
 *
 * Scans every output rather than assuming an index: the agent controls output
 * order, and a wallet may append change. Returns null when no output carries a
 * well-formed tag.
 */
export function findContributionTag(tx: Transaction): ContributionTag | null {
  for (const output of tx.outputs) {
    const tag = readTagFromScript(output.lockingScript)
    if (tag !== null) return tag
  }
  return null
}

/**
 * Read a tag out of one locking script.
 *
 * Only a true `OP_FALSE OP_RETURN` data output counts — a spendable script that
 * merely contains the same bytes must never be mistaken for a tag.
 */
export function readTagFromScript(script: Script): ContributionTag | null {
  const chunks = script.chunks
  if (chunks.length < 2) return null
  if (chunks[0]?.op !== OP.OP_FALSE) return null
  if (chunks[1]?.op !== OP.OP_RETURN) return null

  // The SDK stops parsing pushes at OP_RETURN and hands back everything after
  // it as one raw blob on the OP_RETURN chunk itself, push prefixes included.
  // So re-parse that blob to recover the individual pushes. Scripts whose
  // pushes did come through separately are handled too.
  const candidates: number[][] = []

  const blob = chunks[1]?.data
  if (blob !== undefined && blob.length > 0) {
    try {
      for (const inner of Script.fromBinary(blob).chunks) {
        if (inner.data !== undefined) candidates.push(inner.data)
      }
    } catch {
      /* not parseable as pushes; the raw blob is still tried below */
    }
    candidates.push(blob)
  }
  for (const chunk of chunks.slice(2)) {
    if (chunk.data !== undefined) candidates.push(chunk.data)
  }

  // The first candidate that decodes wins; later pushes are ignored, so a
  // future round can add fields without breaking this.
  for (const data of candidates) {
    let text: string
    try {
      text = Utils.toUTF8(data)
    } catch {
      continue
    }
    const tag = decodeTag(text)
    if (tag !== null) return tag
  }
  return null
}
