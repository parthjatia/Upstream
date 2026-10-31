/**
 * Turning a wallet failure into something actionable.
 *
 * The exact message matters more than our paraphrase of it, so a diagnosis
 * always carries the wallet's own words verbatim. Where we recognise a failure
 * we add what it means and what to try — and say plainly whether the fault is
 * on our side or the wallet's, because that decides whether retrying can help.
 */
import type { WalletExchange } from './walletErrors'

export interface Diagnosis {
  /** The wallet's own message, verbatim. */
  exact: string
  /** Short headline. */
  title: string
  /** Where the fault lies, which decides whether a retry can succeed. */
  side: 'wallet' | 'app' | 'unknown'
  /** What the message means, in plain terms. */
  meaning: string
  /** Concrete things to try, best first. */
  tryThis: string[]
  /** True when nothing was broadcast, so retrying cannot double-spend. */
  nothingSent: boolean
}

/** JSON keys wallets use for the human-readable reason. */
const MESSAGE_KEYS = ['message', 'description', 'error', 'reason']

/**
 * A wallet-toolbox error line: WERR_INTERNAL: Storage method ... failed: ...
 *
 * `\\.` consumes an escape pair, so a message carrying an escaped quote is not
 * truncated at the backslash when it is read out of a JSON body.
 */
const WERR_LINE = /WERR_[A-Z_]+(?:\\.|[^"\n\r])*/

/**
 * Decode a fragment that came out of a JSON string, so `\"` reads as `"`.
 *
 * The text is already escaped, so it must not be escaped again. Text that is
 * not valid JSON (an error message with a bare quote, say) is returned as is.
 */
function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string
  } catch {
    return text
  }
}

/**
 * Pull the wallet's own words out of an error message or a tapped JSON body.
 *
 * A `WERR_*` line wins wherever it appears, because wallet-toolbox puts the
 * whole chain of blame in it — "WERR_INTERNAL: Storage method processAction
 * failed: merged Beef failed validation" says far more than any one JSON field.
 */
function exactMessage(errorMessage: string, exchanges: WalletExchange[]): string {
  const bodies = exchanges.map(x => x.body)

  for (const hay of [errorMessage, ...bodies]) {
    const werr = WERR_LINE.exec(hay)
    if (werr !== null) return unescapeJson(werr[0]).trim()
  }

  for (const hay of bodies) {
    for (const key of MESSAGE_KEYS) {
      const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(hay)
      if (m?.[1] !== undefined && m[1].length > 0) return unescapeJson(m[1])
    }
  }

  return errorMessage
}

/**
 * Known failures.
 *
 * `merged Beef failed validation` comes from wallet-toolbox's `processAction`,
 * raised while the wallet assembles the BEEF for the inputs IT is spending —
 * its own funds, not our outputs. So it fires after approval, and no request of
 * ours can avoid it.
 */
export function diagnoseWalletError(
  errorMessage: string,
  exchanges: WalletExchange[] = [],
  /** The full serialized error: searched for patterns, never shown as `exact`. */
  extra = ''
): Diagnosis {
  const exact = exactMessage(errorMessage, exchanges)
  const hay = [errorMessage, exact, extra, ...exchanges.map(x => x.body)].join('\n')

  if (/merged Beef failed validation/i.test(hay)) {
    return {
      exact,
      title: 'BSV Desktop could not validate the BEEF for its own funds',
      side: 'wallet',
      nothingSent: true,
      meaning:
        'This is raised inside the wallet, in storage method processAction, while it builds the ' +
        'BEEF for the inputs it is spending — the satoshis already in your wallet, not the ' +
        'outputs we asked for. The wallet merges each input source transaction with its merkle ' +
        'proof and revalidates the result; one of those proofs is missing, stale, or does not ' +
        'verify against the headers the wallet currently trusts. That is why it only happens ' +
        'after you approve: the request itself was accepted and the amount shown was right.',
      tryThis: [
        'Let the incoming funds confirm. A proof that does not exist yet cannot validate, and an unconfirmed parent is the most common cause.',
        'Re-sync BSV Desktop so it refetches block headers and proofs for its own outputs.',
        'Check the wallet is reaching its header source. wallet-toolbox 2.14.x defaults to Arcade chaintracks; without current headers no proof can be checked.',
        'Receive a fresh payment and retry, so the wallet selects a different, cleanly proven UTXO.',
        'If it persists, report it against BSV Desktop with this exact message. It is a wallet-side storage or proof problem, not something this app can work around.'
      ]
    }
  }

  if (/insufficient/i.test(hay) || /moreSatoshisNeeded/.test(hay)) {
    return {
      exact,
      title: 'Not enough spendable satoshis',
      side: 'wallet',
      nothingSent: true,
      meaning:
        'The wallet could not cover the outputs plus the fee from its spendable outputs. Funds ' +
        'awaiting confirmation, or held in a non-default basket, do not count.',
      tryThis: [
        'Compare the spendable balance shown above with the total named in the confirmation.',
        'Wait for any incoming payment to become spendable.'
      ]
    }
  }

  if (/doubleSpend/i.test(hay)) {
    return {
      exact,
      title: 'The wallet reported a double spend',
      side: 'wallet',
      nothingSent: false,
      meaning:
        'An input this transaction used has already been spent by another transaction. The ' +
        'competing txids are in the full response below.',
      tryThis: [
        'Open the competing transaction on the explorer before retrying.',
        'Re-sync the wallet so it stops offering an already spent output.',
        'Run "Check for stuck actions" — an unfinished action can hold inputs.'
      ]
    }
  }

  if (/HTTP status \d+/.test(hay) && exchanges.length === 0) {
    return {
      exact,
      title: 'The wallet rejected the request, and the reason was not captured',
      side: 'unknown',
      nothingSent: true,
      meaning:
        'The SDK discards the wallet response body unless it decodes as a structured error ' +
        'envelope, and no body was captured for this call.',
      tryThis: [
        'Retry with the browser console open; the fetch tap records the raw body.',
        "Check BSV Desktop's own logs for the matching entry."
      ]
    }
  }

  return {
    exact,
    title: 'The wallet call failed',
    side: 'unknown',
    nothingSent: false,
    meaning: 'This failure is not one we recognise. The wallet response is below in full.',
    tryThis: [
      'Check whether the balance changed, and whether the transaction appears on the explorer.',
      'Run "Check for stuck actions" before retrying.'
    ]
  }
}
