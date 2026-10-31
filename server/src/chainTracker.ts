import type { ChainTracker } from '@bsv/sdk'

/** Guide §20.3: validate BEEF proofs against Arcade block headers. */
export class ArcadeChainTracker implements ChainTracker {
  constructor(private readonly url: string) {}
  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const response = await fetch(
      `${this.url}/chaintracks/v2/header/height/${height}`
    )
    if (response.status === 404) return false
    if (!response.ok)
      throw new Error(`Arcade header request failed (${response.status}).`)
    const header = (await response.json()) as { merkleRoot: string }
    return header.merkleRoot.toLowerCase() === root.toLowerCase()
  }
  async currentHeight(): Promise<number> {
    const response = await fetch(`${this.url}/chaintracks/v2/height`)
    if (!response.ok)
      throw new Error(`Arcade height request failed (${response.status}).`)
    return ((await response.json()) as { height: number }).height
  }
}
