# Upstream — project brief for the coding agent

> Read this file, `AGENTS.md` and `docs/bsv-pack/BSV_STACK_COMPLETE_GUIDE.md` (Appendix A) before writing code.
> Prefer the pack's tested code over code from memory. Use the package versions pinned in `AGENTS.md`.
> Work on ONE phase at a time. When a phase is done, tell me how to test it, then commit with the given message.

## One-liner
AI agents automatically pay a few satoshis to every open-source project they use. A sponsor adds a matching pool that is split with **quadratic funding**, so projects with many independent supporters get most of the bonus. Everything settles on BSV.

## Why (for the pitch)
Unpaid maintainers are a security vulnerability: Heartbleed (OpenSSL, 2014), event-stream (npm, 2018), Log4Shell (2021), colors.js/faker.js (2022), xz backdoor (2024). AI agents now use open source more than humans do, but pay nothing.

## Hard rules (BSV track)
- User-facing flows (funding agents, settling the round) go through a standard BSV wallet (BSV Desktop) via `WalletClient`. Never ask for a private key or recovery phrase.
- Real transactions on **BSV mainnet**. Agents broadcast through Arcade mainnet (`https://arcade-v2-us-1.bsvblockchain.tech`, headers at `/chaintracks/v2`). Explorer links are `https://whatsonchain.com/tx/<txid>`.
- **Total budget is 200,000 sats and it is real money.** Every amount lives in `.env` (see Budget below) — never hard-code a satoshi figure. Contribution sizes are configurable.
- Non-custodial: contributions go directly from agent to project; the sponsor pays matching from their own wallet at settlement. Nobody holds pooled funds.
- At least one real AI agent (LLM with tool calling) makes payments.
- Secrets (agent keys, LLM API key) live in `.env` / `keys/` which are gitignored. Never commit them. Commit `.env.example` instead.

## Budget (200,000 sats, mainnet)

| What | Env var | Amount |
|---|---|---|
| Lisa's agent | `FUND_LISA_SATS` | 5,000 |
| Swarm: 50 agents x 1,500 | `SWARM_SIZE`, `FUND_SWARM_AGENT_SATS` | 75,000 |
| Whale (one payment) | `FUND_WHALE_SATS` | 20,000 |
| Attacker: 10 agents x 200 | `SYBIL_SIZE`, `FUND_SYBIL_AGENT_SATS` | 2,000 |
| **Funding transaction total** | | **102,000** |
| Sponsor matching pool (stays in BSV Desktop until settlement) | `SPONSOR_POOL_SATS` | 50,000 |
| Buffer for fees and retries | | ~48,000 |
| **Total** | `TOTAL_BUDGET_SATS` | **200,000** |

Contribution sizes are configurable too: `CONTRIBUTION_SATS` (default 10) for
ordinary agent payments and `WHALE_CONTRIBUTION_SATS` for the whale's single
large one. The whale is funded 20,000 and contributes slightly less so its
transaction can pay a fee.

Code must read these from `.env` through `shared/budget.ts`, which validates
that funding + pool stays within `TOTAL_BUDGET_SATS`.

## Architecture
```
upstream/
  AGENTS.md                 ← from the BSV developer pack
  PROJECT_BRIEF.md          ← this file
  docs/bsv-pack/            ← START-HERE.md, BSV_STACK_COMPLETE_GUIDE.md
  shared/                   ← types, projects.json, quadraticMatch(), OP_RETURN helpers
  server/                   ← Express: tally, verification, matching, SSE events
  agents/                   ← lisa.ts (LLM), swarm.ts, whale.ts, sybil.ts, lib/contribute.ts
  web/                      ← Vite + React: fund agents, galaxy, sponsor settle
  keys/                     ← generated keys (GITIGNORED)
  data/                     ← funding tx BEEF, contributions log (GITIGNORED)
```
Root scripts: `npm run keys`, `npm run server`, `npm run web`, `npm run lisa`, `npm run swarm`, `npm run whale`, `npm run sybil`, `npm test`.

## Data formats
- `shared/projects.json`: `[{ id, name, address, story }]` — 5 demo projects (addresses only, keys stay in `keys/`):
  - `tiny-tls` (inspired by Heartbleed), `stream-utils` (event-stream), `log-helper` (Log4Shell), `color-text` (colors.js), `compress-lite` (xz). Display names end with "(demo)".
- OP_RETURN on every contribution: `UPSTREAM|<round>|<projectId>` (UTF-8, `OP_FALSE OP_RETURN <hex>`).
- Contribution report to server: `{ rawTxHex, projectId, agentPubKey, ownerPubKey, ownerSignature }`.
- Server events (SSE `/events`): `{ type: 'contribution' | 'rejected' | 'tally' | 'settled', ... }`.

## Identity rule (Sybil defence)
- Every agent belongs to an owner (identity public key). The owner signs the agent's public key.
- Lisa's agent: signed in the browser by BSV Desktop (`createSignature` with `counterparty: 'anyone'`; owner = `getPublicKey({ identityKey: true })`).
- Swarm: 100 simulated owners with generated keys sign their agents the same way (SDK `ProtoWallet`).
- Sybil attacker: agents with NO valid owner signature → server rejects them (emit `rejected` event).
- Matching counts OWNERS, not agents or transactions.
- Fallback if signature verification takes > 45 min: allowlist of registered agent keys in `data/registry.json`.

## Quadratic matching (use exactly this logic)
```ts
type C = { project: string; owner: string; sats: number }
export function quadraticMatch(contribs: C[], pool: number) {
  const byProject = new Map<string, Map<string, number>>()
  for (const c of contribs) {
    const owners = byProject.get(c.project) ?? new Map()
    owners.set(c.owner, (owners.get(c.owner) ?? 0) + c.sats)
    byProject.set(c.project, owners)
  }
  const rows = [...byProject].map(([project, owners]) => {
    let sumSqrt = 0, raised = 0
    for (const s of owners.values()) { sumSqrt += Math.sqrt(s); raised += s }
    const raw = sumSqrt ** 2 - raised
    return { project, raised, supporters: owners.size, gap: raw > GAP_EPSILON ? raw : 0 }
  })
  const totalGap = rows.reduce((a, r) => a + r.gap, 0)
  return rows.map(r => ({
    ...r,
    match: totalGap > GAP_EPSILON ? Math.floor((r.gap / totalGap) * pool) : 0
  }))
}
```

`Math.sqrt(s) ** 2 - s` is not exactly 0 for every `s` (5.68e-14 for 500,
exactly 0 for 1,000), so `GAP_EPSILON = 1e-6` floors that residue away. Without
it, a round in which every project has a single supporter divides the pool by
rounding noise instead of paying nothing. The smallest real gap — two supporters
of 1 sat each — is 2, so the floor cannot swallow genuine matching demand.

---

## Phases (do them in order, one at a time)

### Phase 1 — Scaffold
- npm workspaces monorepo with `shared`, `server`, `agents`, `web` (TypeScript everywhere, `tsx` to run scripts).
- Install `@bsv/sdk` (and any other BSV packages) at the versions pinned in AGENTS.md.
- `.gitignore`: `node_modules`, `.env`, `keys/`, `data/`, `dist/`. Add `.env.example`.
- **Done when:** `npm install` works and `npm run server` / `npm run web` start empty apps.
- **Commit:** `chore: scaffold monorepo`

### Phase 2 — Keys and projects
- `npm run keys`: generate 5 project keys, 1 Lisa agent key, `SWARM_SIZE` (50) swarm agent keys + the same number of swarm owner keys, 1 whale agent + owner, `SYBIL_SIZE` (10) sybil agent keys. Save to `keys/*.json`. Write **mainnet** addresses into `shared/projects.json`.
- Add `shared/budget.ts`: read every amount and count from `.env`, with the Budget table above as defaults, and refuse a budget whose funding + pool exceeds `TOTAL_BUDGET_SATS`.
- Add `quadraticMatch` to `shared/` with a unit test: whale (1 owner × 50,000) vs crowd (500 owners × 10) vs medium (50 × 100) with pool 100,000 → crowd ≈ 91,000, medium ≈ 9,000, whale 0.
- **Done when:** `npm test` passes and no key files are tracked by git (`git status`).
- **Commit:** `feat: key generation, project registry, quadratic matching`

### Phase 3 — Fund agents from BSV Desktop (first real transaction)
- Web page "Fund agents": connect BSV Desktop with `WalletClient`, then ONE `createAction` with a P2PKH output to every agent address. Amounts come from `.env` via the server, never from hard-coded numbers: Lisa `FUND_LISA_SATS`, each swarm agent `FUND_SWARM_AGENT_SATS`, the whale `FUND_WHALE_SATS`, each sybil agent `FUND_SYBIL_AGENT_SATS` — 102,000 sats over 62 outputs at the default budget.
- The server owns the funding plan (it can read `keys/`; the browser cannot): expose agent addresses and amounts for the web page to spend to.
- Send the returned transaction (AtomicBEEF) to the server; server saves it to `data/funding.beef` and records which output index belongs to which agent.
- Show the txid with a link to `https://whatsonchain.com/tx/<txid>`.
- **Done when:** the funding tx is visible on WhatsOnChain.
- **Commit:** `feat: fund agents from BSV Desktop in one transaction`

### Phase 4 — Contribution hook
- `agents/lib/contribute.ts`: spend the agent's current UTXO → output 1: P2PKH to the project (`CONTRIBUTION_SATS`, default 10), output 2: OP_RETURN `UPSTREAM|<round>|<projectId>`, output 3: change back to the agent. `fee()`, `sign()`, broadcast via Arcade, then the change output becomes the agent's next UTXO (chain unconfirmed transactions). Persist each agent's latest UTXO to `data/`.
- Report each contribution to the server.
- `paidTool(projectId, fn)` wrapper: pay first, then run `fn`.
- Script `npm run test-pay`: one contribution from Lisa's agent to `tiny-tls`, print the WhatsOnChain link.
- **Done when:** one agent-made contribution is visible on WhatsOnChain.
- **Commit:** `feat: agent contribution hook broadcasting via Arcade`

### Phase 5 — Tally server
- `POST /contribution`: parse the raw tx with the SDK, check the project output and amount, check the OP_RETURN round/project, verify the owner signature. Valid → store + emit `contribution`; invalid → emit `rejected`.
- `GET /tally`: run `quadraticMatch` over valid contributions with the sponsor's pledged pool.
- `POST /pledge`: set pool size. `GET /events`: SSE stream.
- Spot-check only a sample of txids on WhatsOnChain (rate limits).
- **Done when:** `test-pay` contributions appear in `/tally`.
- **Commit:** `feat: tally server with verification and quadratic matching`

### Phase 6 — Lisa's agent (the real AI agent)
- `npm run lisa`: an LLM with tool calling (API key from `.env`) gets the task "Build a one-page website for Lisa's bakery and save it to `data/lisa-bakery.html`."
- Tools (each wrapped in `paidTool` for one project): `formatDate` (stream-utils), `compressText` (compress-lite), `spellCheck` (log-helper), `generatePalette` (color-text), `secureHash` (tiny-tls). Keep the tools simple real functions.
- Log each tool call with its payment txid.
- **Done when:** Lisa's agent finishes the page and made ≥ 5 real payments.
- **Commit:** `feat: LLM agent paying per tool use`

### Phase 7 — Swarm, whale, sybil
- `npm run swarm`: `SWARM_SIZE` (50) agents in parallel, each loop: pick a tool (weighted so small libraries like `stream-utils` and `compress-lite` get most usage), contribute 10 sats, wait 0.5–2 s. Configurable duration.
- `npm run whale`: one contribution of `WHALE_CONTRIBUTION_SATS` to `tiny-tls`.
- `npm run sybil`: `SYBIL_SIZE` (10) unsigned agents contribute to a fake project `totally-legit` → all rejected by the server.
- **Done when:** swarm produces hundreds of txs, whale lands, sybil is rejected.
- **Commit:** `feat: swarm, whale and sybil scripts`

### Phase 8 — Galaxy UI
- One bubble per project (d3-force), sized by `match`, with a card showing the project's real-world security story.
- Each SSE contribution = a particle flying into its bubble (Lisa gold, swarm white, whale blue). Rejected = red particle that bounces off.
- Side panel: live tx ticker with WhatsOnChain links; table of supporters / raised / match per project.
- Sponsor panel: pledge amount input.
- **Done when:** running the swarm visibly animates the galaxy.
- **Commit:** `feat: live funding galaxy`

### Phase 9 — Settlement
- "Settle round" button: fetch `/tally`, then BSV Desktop `createAction` with one P2PKH output per project with `match > 0` plus an OP_RETURN containing the SHA-256 of the round results JSON.
- Animate the pool fanning out into the bubbles; show the WhatsOnChain link.
- **Done when:** the settlement tx is on WhatsOnChain.
- **Commit:** `feat: one-click round settlement from BSV Desktop`

### Phase 10 — README and submission
- README: problem, what it does, architecture diagram, setup (`npm install`, `.env.example`, `npm run keys`, run order), demo script, WhatsOnChain links (funding fan-out, one Lisa contribution, whale, settlement), what it brings to BSV.
- **Commit:** `docs: README and demo instructions`

## Demo video (≤ 2.5 min)
1. Problem (security incidents, unpaid maintainers) — 20 s
2. Fund agents from BSV Desktop + sponsor pledge — 30 s
3. Lisa's agent builds the bakery page, paying per tool use — 30 s
4. Swarm lights up the galaxy — 20 s
5. Whale vs crowd, then sybil attack rejected — 25 s
6. Settle round in one click, WhatsOnChain link — 20 s
7. Close: "Usage becomes the vote. Only BSV makes payments this small viable." — 5 s
