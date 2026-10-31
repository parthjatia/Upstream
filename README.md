# Upstream

**AI agents pay a few satoshis to every open-source project they use. A sponsor adds a matching pool, and quadratic funding splits it so projects with many independent supporters get most of the bonus. Everything settles on BSV mainnet.**

> Usage becomes the vote. Only BSV makes payments this small viable.

- Pitch, users and what this brings to BSV: [docs/DEVFOLIO.md](docs/DEVFOLIO.md)
- How it fits together (with a diagram): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- The 2.5-minute demo video script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)
- On-chain proof (WhatsOnChain links): [docs/tx-links.md](docs/tx-links.md)

---

## The problem

Unpaid maintainers are a security vulnerability, and everyone shares it:

| Year | Incident | What went wrong |
|---|---|---|
| 2014 | **Heartbleed** (OpenSSL) | Most of the internet's TLS was run by a few volunteers on about $2,000 a year in donations. A buffer over-read exposed server memory to anyone who asked. |
| 2018 | **event-stream** (npm) | A burnt-out maintainer handed the package to a stranger, who shipped code that stole Bitcoin wallets. About 2 million weekly downloads, no funding. |
| 2021 | **Log4Shell** (Log4j) | One logging library gave remote code execution on millions of Java servers. Unpaid volunteers patched it over the holidays. |
| 2022 | **colors.js / faker.js** | The author, tired of companies profiting from his unpaid work, broke his own packages on purpose. Thousands of builds failed overnight. |
| 2024 | **xz backdoor** | An attacker spent two years earning the trust of an overwhelmed solo maintainer, became co-maintainer, and planted an SSH backdoor that nearly shipped in every Linux distribution. |

AI agents now pull in open-source code more than people do, and they pay nothing for it.

## What Upstream does

1. **Agents pay per use.** When an agent calls a library, a `paidTool` wrapper first pays the project `CONTRIBUTION_SATS` (10 sats by default) in a real BSV transaction, then runs the tool. If the payment fails, the tool doesn't run.
2. **Each payment is tagged on-chain.** Every contribution carries an `OP_RETURN` of `UPSTREAM|<round>|<projectId>`, so anyone can audit the round from the chain alone.
3. **Owners vouch for agents.** Each agent's public key is signed by its owner's identity key. The tally server checks that signature, and **matching counts owners**, not agents or transactions. Agents with no owner (a Sybil attack) are rejected.
4. **Quadratic funding splits the sponsor's pool.** A project's matching weight is `(Σ √contribution per owner)² − raised`. Many small supporters beat one whale.
5. **Settlement is non-custodial.** Contributions go straight from agent to project. The sponsor's pool stays in their own BSV Desktop wallet until they settle the round with one transaction.

### Why BSV

- **A wallet is just a key.** An agent can create its own wallet in microseconds: generate a private key and you have an address. No account, no KYC, no sign-up.
- **Maintainers publish an address.** A maintainer would put a BSV address in their `package.json` `funding` field, and any agent that installs the package knows where to pay. (In this demo the five project addresses live in `shared/projects.json`. See [DEVFOLIO.md](docs/DEVFOLIO.md#maintainers-publish-an-address).)
- **10-satoshi payments make sense.** A contribution transaction is about 250 bytes, and the fee at 1 sat/kB is a fraction of a cent. Agents chain unconfirmed transactions, using the change of one payment as the input of the next, so one funding output is enough for hundreds of payments.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Monorepo scaffold | done |
| 2 | Keys, project registry, budget guard, quadratic matching | done |
| 3 | Fund all agents from BSV Desktop in one transaction, plus Lisa's owner attestation | done (web page, steps 1–5) |
| 4 | Contribution hook (`contribute`, `paidTool`, `npm run test-pay`), DRY_RUN mode | done |
| 5 | Tally server: verification, quadratic matching, pledge, SSE | done |
| 6 | Lisa's agent: an LLM with tool calling that pays per tool use | done |
| 7 | Swarm, whale and Sybil attacker scripts | done |
| 8 | **Galaxy UI** (d3-force bubbles, live particles) | **not started** |
| 9 | Settlement (one-click from BSV Desktop) and `npm run demo:check` | done |
| 10 | Docs | this |

Everything except the galaxy UI is built, and the whole demo runs end to end with
`DRY_RUN=true`. Phase 8 is the one piece not started: the `/events` SSE stream
already emits `contribution`, `rejected`, `tally` and `settled`, so the galaxy has
a live feed to animate whenever it gets built.

**Funding from the wallet is blocked.** BSV Desktop accepts the funding request
and shows the right amount, then fails after approval with:

```
WERR_INTERNAL: Storage method processAction failed: merged Beef failed validation
```

That is raised inside the wallet, while it assembles the BEEF for the inputs *it*
is spending — its own funds, not our outputs — so nothing in this app can work
around it, and nothing is broadcast. The web page shows the message verbatim with
what to try. Until it is resolved, fund with a manual Send plus
`npm run import-funding <txid>`, or stay in dry-run. See
[Going live](#going-live-checklist).

---

## Setup

Requirements: **Node.js ≥ 22**, and for live mode, [BSV Desktop](https://bsvblockchain.org) on **mainnet**.

```bash
npm install
cp .env.example .env        # then read the comments in it
npm run keys                # generates keys/*.json (gitignored) + writes addresses into shared/projects.json
```

`npm run keys` generates 5 project keys, Lisa's agent key, `SWARM_SIZE` swarm agents with one owner each, a whale agent and owner, and `SYBIL_SIZE` attacker agents with **no** owner. It won't overwrite existing keys unless you pass `--force`. Once those addresses have been funded, regenerating them would strand real satoshis.

`keys/`, `data/` and `.env` are gitignored. Never commit them.

### Configuration (`.env`)

Every satoshi amount and count is read from `.env` through `shared/budget.ts`, and nothing is hard-coded. The server and every script **refuse to start** if funding + sponsor pool exceeds `TOTAL_BUDGET_SATS`, if the whale can't afford its fee, or if any agent is funded with no more than one contribution.

| Var | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | See below. |
| `PORT` / `SERVER_URL` / `VITE_SERVER_URL` | `8787` / `http://localhost:8787` | Tally server port, where agents report, where the browser looks. Keep them pointing at the same server. |
| `ROUND` | `round-1` | Round id in the OP_RETURN tag. |
| `ARCADE_URL` | `https://arcade-v2-us-1.bsvblockchain.tech` | Broadcast endpoint (mainnet). |
| `SWARM_SIZE`, `SYBIL_SIZE` | 50, 10 | Agent counts. |
| `FUND_LISA_SATS`, `FUND_SWARM_AGENT_SATS`, `FUND_WHALE_SATS`, `FUND_SYBIL_AGENT_SATS` | 5,000 / 1,500 / 20,000 / 200 | Per-agent funding: 102,000 sats over 62 outputs. |
| `CONTRIBUTION_SATS` | 10 | What an agent pays per tool call. |
| `WHALE_CONTRIBUTION_SATS` | 19,500 | The whale's single payment. |
| `SPONSOR_POOL_SATS` | 50,000 | Default matching pool. It stays in the sponsor's wallet. |
| `TOTAL_BUDGET_SATS` | 200,000 | Hard ceiling. |

#### Lisa's LLM

Three names, and only these three — provider-specific aliases such as
`ANTHROPIC_API_KEY` are deliberately not read, so there is one place to look when
Lisa runs on the wrong model or cannot authenticate.

| Var | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic` or `openai`. |
| `LLM_API_KEY` | — | That provider's key. Never printed, never logged, never committed. |
| `LLM_MODEL` | `claude-sonnet-5-5` (anthropic), `gpt-5` (openai) | Optional override. |
| `LISA_MAX_TOOL_CALLS` | 25 | Cap on paid tool calls per run. |
| `SWARM_DURATION_SEC`, `SWARM_DELAY_MS` | 120, `500-2000` | How long the swarm runs, and the pause between one agent's contributions. |

With `DRY_RUN=true` and no key, `npm run lisa` uses a scripted stand-in — clearly
labelled, not an LLM — so the payment path can be exercised without an API key.
With `DRY_RUN=false` a real key is required and the scripted planner is refused.

---

## DRY_RUN vs live

There's **one switch**, and both modes use the same code path:

| | `DRY_RUN=true` (default) | `DRY_RUN=false` |
|---|---|---|
| Transaction built, fee computed | yes | yes |
| Signed with the agent's real key | yes | yes |
| Script-verified by the SDK before leaving the machine | yes | yes |
| Broadcast to Arcade | **no** | yes |
| Reported to the tally server | yes, marked `dryRun: true` | yes |
| Agents' starting coins | synthetic, from `npm run seed-agents` (a funding tx with no input, so it can never be broadcast; marked `synthetic: true`) | real, from the BSV Desktop funding tx or `npm run import-funding <txid>` |
| Owner for Lisa's agent if BSV Desktop hasn't signed yet | a simulated owner kept in `data/dry-run-owners.json` (never stored as an attestation) | none, so the server rejects her contributions, which is correct |

Anything other than an explicit `false` / `0` / `no` / `off` keeps dry-run, so a typo can't broadcast by accident. `npm run seed-agents` refuses to run when `DRY_RUN=false`. Every script prints the mode on its first line.

`GET /tally` reports `dryRunContributions` and `dryRun`, so a dry-run tally is never mistaken for settled money.

---

## Run order

### Dry run (works today, no wallet)

```bash
# terminal 1
npm run server              # tally server on $PORT

# terminal 2
npm run seed-agents         # synthetic starting coins for every agent
npm run test-pay            # one contribution: Lisa's agent → tiny-tls  (or: npm run test-pay stream-utils)
npm run test-tally          # crowd vs whale vs sybil, against the tally (offline-built txs)
curl http://localhost:8787/tally
```

`test-pay` prints the transaction's outputs (project payment, OP_RETURN tag, change), the fee, whether it was broadcast, and whether the tally counted it. Run it again and you'll see the change chain into the next input.

Optional: `npm run web` opens the funding page on http://localhost:5173. It needs BSV Desktop to do anything useful.

### Live (after the go-live checklist)

```bash
npm run server
npm run web                 # http://localhost:5173
```

In the web page (all signing happens in BSV Desktop; the page never asks for a key):

1. **Wallet**: connect BSV Desktop and check that it says `mainnet`.
2. **Wallet actions**: look for unfinished funding actions before spending.
3. **Smoke test**: fund Lisa's agent alone (`FUND_LISA_SATS`).
4. **Full fan-out**: one transaction, one P2PKH output per agent (102,000 sats over 62 outputs by default). The server saves the AtomicBEEF to `data/` and maps each output to its agent by locking script.
5. **Vouch for Lisa's agent**: BSV Desktop signs her agent's public key with your identity key.

If you funded with a manual Send instead, run `npm run import-funding <txid>`.

Then:

```bash
npm run test-pay            # one real contribution, prints the WhatsOnChain link
npm run lisa                # the LLM agent builds the bakery page, paying per tool call
npm run swarm               # SWARM_SIZE agents in parallel, weighted towards the small libraries
npm run whale               # one large payment to tiny-tls
npm run sybil               # unvouched agents, all rejected by the tally
npm run demo:check          # pre-flight: keys, budget, UTXOs, tally, wallet
# then settle the round from the web page
```

`swarm`, `whale`, `lisa` and `sybil` each hold their own UTXO file under
`data/utxos/`, so they are safe to run **at the same time** in separate
processes.

### Scripts that exist today

| Script | What it does |
|---|---|
| `npm run keys` | Generate keys, write project addresses. |
| `npm run seed-agents` | Dry-run only: synthetic coins for every agent. |
| `npm run import-funding <txid>` | Adopt a real funding tx (one WhatsOnChain fetch); outputs matched by locking script. |
| `npm run test-pay [projectId]` | One contribution from Lisa's agent. |
| `npm run server` | Tally server. |
| `npm run lisa` | The LLM agent: builds `data/lisa-bakery.html`, paying per tool call. |
| `npm run swarm` | `SWARM_SIZE` agents in parallel (`npm run swarm:demo` for 60 s, or `-- --duration <sec>`). |
| `npm run whale` | One `WHALE_CONTRIBUTION_SATS` payment to `tiny-tls`. |
| `npm run sybil` | `SYBIL_SIZE` unvouched agents; every one is rejected. |
| `npm run demo:check` | Pre-flight across keys, budget, UTXOs, tally and the wallet. |
| `npm run test-tally` | Exercise verification and matching with offline-built transactions (never broadcast). |
| `npm run web` / `build:web` | Funding page (Vite + React). |
| `npm test` / `npm run typecheck` | Vitest suite / `tsc --noEmit`. |

---

## Going-live checklist

Mainnet, real money: **200,000 sats total**. Work down this list in order.

- [ ] `npm test` and `npm run typecheck` pass.
- [ ] `npm run demo:check` reports **ready**.
- [ ] The dry run passes end to end: `lisa`, `swarm`, `whale`, `sybil`, settlement preview.
- [ ] The BEEF failure above is resolved, **or** you are funding by manual Send plus `npm run import-funding <txid>`.
- [ ] `keys/` exists and is **backed up** somewhere safe. Don't run `npm run keys -- --force` after funding.
- [ ] `git status` shows no `keys/`, `data/` or `.env`.
- [ ] `.env` amounts reviewed. `GET /health` returns the full budget, and `committed ≤ TOTAL_BUDGET_SATS`.
- [ ] `SERVER_URL` and `VITE_SERVER_URL` point at the same running server.
- [ ] BSV Desktop installed, on **mainnet**, with enough balance for funding + pool + fees.
- [ ] Clear the dry-run state: move `data/` aside (synthetic UTXOs, dry-run contributions and simulated owners should not mix with the live round). Real imported outputs always win over synthetic ones, but a clean `data/` keeps the tally honest. *(Or bump `ROUND`. The tally only counts contributions for the current round.)*
- [ ] Set `DRY_RUN=false` and restart the server.
- [ ] Web page step 3: smoke-test with Lisa only, then check the tx on WhatsOnChain.
- [ ] Web page step 5: vouch for Lisa's agent (BSV Desktop signature).
- [ ] `npm run test-pay`: one real contribution, check it on WhatsOnChain and in `/tally`.
- [ ] Web page step 4: full fan-out, then check it on WhatsOnChain.
- [ ] Run the agents, then settle.
- [ ] Paste every txid into [docs/tx-links.md](docs/tx-links.md).

---

## Repository layout

```
shared/   budget guard, runtime (DRY_RUN), projects, quadratic matching, OP_RETURN tag,
          owner attestations, settlement (shared by the server and the browser)
server/   Express tally server: funding plan, attestations, contribution verification,
          /tally, /pledge, settlement routes, SSE /events
agents/   keys, seed-agents, import-funding, test-pay, test-tally, lisa, swarm, whale, sybil
          lib/contribute.ts (contribute + paidTool), lib/utxos.ts (one file per agent)
          tools/ (the LLM loop, the five library tools, owner lookup)
web/      Vite + React page: connect BSV Desktop, fund agents, vouch for Lisa, settle
scripts/  demo-check.ts (npm run demo:check)
docs/     these docs + bsv-pack/ (the BSV stack guide)
keys/     generated keys (GITIGNORED)
data/     funding BEEF, utxos/<agent>.json, contributions, pool, Lisa's page (GITIGNORED)
```

`shared/settlement.ts` is browser-safe and used by **both** sides: the server
builds the settlement preview with it, and the web panel rebuilds the outputs
from the results JSON with the same code, so the browser never signs a locking
script it merely received from the server.

Built for the TUM Blockchain & AI Hackathon 2026 (BSV track). The five projects are **demos** named after the incidents above. They aren't the real packages, and their keys are ours.
