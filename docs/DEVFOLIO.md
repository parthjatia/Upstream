# Upstream: Devfolio submission

**Tagline:** AI agents pay the open-source projects they use, a few satoshis per call, and quadratic funding turns that usage into a vote on where a sponsor's matching pool goes. Settled on BSV.

---

## The problem

Open source runs the world, and the people who maintain it are mostly unpaid. That isn't only unfair. It's a **security vulnerability**:

- **Heartbleed (2014).** OpenSSL secured most of the web's TLS traffic, and it was maintained by a handful of volunteers on roughly $2,000 a year in donations. A single buffer over-read let anyone read server memory: private keys, passwords, sessions.
- **event-stream (2018).** The burnt-out maintainer of an npm package with ~2 million weekly downloads handed it to a stranger who offered to help. The stranger shipped malware that stole Bitcoin wallets.
- **Log4Shell (2021).** One feature in Log4j gave remote code execution on millions of Java servers. A few unpaid volunteers patched it over the holidays while every company on earth waited on them.
- **colors.js / faker.js (2022).** The author, tired of large companies profiting from his free work, deliberately pushed broken versions. Thousands of builds failed overnight.
- **xz backdoor (2024).** An attacker spent two years building trust with the overwhelmed solo maintainer of a compression library, became co-maintainer, and planted an SSH backdoor that nearly shipped in every major Linux distribution.

The pattern is the same every time: **critical code, one tired person, no money.**

Now **AI agents** are the heaviest users of open source. They install packages, call libraries and run tools all day, on behalf of millions of people. They pay nothing, and nobody even counts what they use.

## The solution

**Upstream makes usage pay, and makes usage the vote.**

1. **Pay per use.** Wrap any tool with `paidTool(projectId, fn)`. Before the tool runs, the agent pays the project a few satoshis (10 by default) in a real BSV transaction. If the payment fails, the tool doesn't run.
2. **Tag it on-chain.** Each payment carries an OP_RETURN `UPSTREAM|<round>|<projectId>`. The round can be audited from the blockchain alone.
3. **One owner, one voice.** Every agent is vouched for by its owner's identity key (a wallet signature over the agent's public key). Matching counts **owners**, not agents or transactions. Agents with no owner are rejected, which defeats Sybil attacks.
4. **Quadratic matching.** A sponsor pledges a pool. Each project's share is proportional to `(Σ √contribution per owner)² − raised`. A thousand people's agents paying 10 sats each outweigh one whale paying 20,000. The money follows breadth of real use.
5. **Non-custodial settlement.** Contributions go straight from agent to project. The sponsor's pool stays in their own wallet until they settle the round with one transaction from BSV Desktop to every project.

## Target users

| User | What they get |
|---|---|
| **Open-source maintainers**, especially of small, deep dependencies nobody thinks about (the `xz`s and `event-stream`s) | A steady income that scales with how much their code is actually used, without asking for donations or running a company. They publish one address. |
| **People and companies running AI agents** | A cheap, automatic way to give back in proportion to use, at fractions of a cent per call, with no billing setup and no invoices. Plus a visible "my agents fund their dependencies" story. |
| **Sponsors**: foundations, security funds, big companies that depend on open source | A matching pool that goes to the projects real usage says matter, with Sybil resistance and an on-chain audit trail instead of a grant committee. |
| **Agent and tool platforms** | A drop-in `paidTool` wrapper to offer "fund what you use" as a default. |

## How people use it

**A maintainer**

1. Adds a BSV address to their package (see below).
2. That's it. Payments arrive directly in their wallet as agents use the code, plus a share of each round's matching pool.

**An agent owner (like Lisa)**

1. Funds their agent from BSV Desktop: one click, one transaction.
2. Vouches for the agent: BSV Desktop signs the agent's public key with the owner's identity key, so their support counts in matching.
3. Uses the agent normally ("build me a website for my bakery"). Every tool call pays the project behind it, automatically.

**A sponsor**

1. Pledges a matching pool (the money stays in their wallet).
2. Watches the round live: who's being used, by how many distinct owners.
3. Clicks **Settle round**. One transaction from their wallet pays every project its quadratic match, with a SHA-256 of the results in an OP_RETURN.

### A wallet is just a key

On BSV, a wallet isn't an account you sign up for. It's a **private key**, and its address is derived from it. An AI agent can create its own wallet instantly, offline, for free, with one line of code. There's no KYC, no API key and no custodian. That's what lets *every* agent have its own wallet and its own budget, funded once by its owner.

### Maintainers publish an address

npm's `package.json` already has a [`funding`](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#funding) field that tools read. A maintainer would put their BSV address there:

```json
{
  "name": "compress-lite",
  "funding": { "type": "bsv", "url": "bitcoin:1C3rVs9285QmbNwaWonfuvnacXCQrh6R3G" }
}
```

Any agent that installs or calls the package then knows exactly where to pay, with no registry and no middleman. *(This is the convention we propose. In the hackathon demo, the five project addresses are generated by `npm run keys` and stored in `shared/projects.json`.)*

## What it brings to BSV

- **A real micropayment workload.** Hundreds of genuine 10-satoshi payments a minute from autonomous agents, each one with economic meaning. This is the use case BSV's low fees exist for: at 1 sat/kB, a ~250-byte contribution costs a fraction of a cent to send.
- **Agents as first-class economic actors.** Agents hold their own keys, chain unconfirmed transactions (the change of each payment funds the next), and broadcast through Arcade. They're a reference pattern for agent payments on BSV.
- **Standard wallet flows for humans.** Funding, vouching and settlement all go through BSV Desktop with `WalletClient` (`createAction`, `createSignature`). The app never asks for a private key.
- **Verifiable public goods funding.** OP_RETURN tags plus `counterparty: 'anyone'` owner attestations mean anyone can recompute a round's tally from the chain and check it against the settlement hash.
- **A path to millions of new transactions.** Every package manager, agent framework and tool registry is a potential integration point, and each one turns everyday software usage into BSV transactions.

## Technology

- `@bsv/sdk` 3.2.1: transactions, P2PKH, OP_RETURN, `ProtoWallet` attestations, SDK script verification.
- BSV Desktop via `WalletClient('auto')`: funding (`createAction`, `randomizeOutputs: false`), owner attestation (`createSignature`, protocol `[1, 'upstream agent']`).
- Arcade (mainnet) for broadcasting. WhatsOnChain for explorer links.
- TypeScript monorepo: Express tally server with SSE, Vite + React front end, Node agent scripts. Vitest suite.
- An LLM with tool calling as Lisa's agent *(Phase 6, in progress)*.

## Status at submission time

Built and tested: key generation, budget guard, one-transaction agent funding from BSV Desktop, owner attestations, the contribution hook with DRY_RUN, and the tally server with verification and quadratic matching.

In progress in parallel: Lisa's LLM agent (Phase 6), swarm / whale / Sybil scripts (Phase 7), one-click settlement (Phase 9). Not started: the galaxy visualisation (Phase 8).

On-chain proof: see [tx-links.md](tx-links.md).
