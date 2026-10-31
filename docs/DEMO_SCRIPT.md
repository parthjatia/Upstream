# Demo video script (2:30 max)

Seven beats, timed to the brief. **VO** is the voice-over and **SCREEN** is what's on screen. Keep a WhatsOnChain tab ready for every txid in [tx-links.md](tx-links.md).

> Status: beats 1, 2 and the first contribution in 3 can be recorded today. Beats 3 (Lisa's agent), 4–5 (swarm, whale, sybil) and 6 (settlement) depend on Phases 6, 7 and 9, which are being built in parallel sessions. The galaxy (Phase 8) isn't started yet. Until it exists, use the tally table and the server log.

---

### 1. Problem: 0:00–0:20 (20 s)

**SCREEN:** Five headlines, one per second: Heartbleed 2014 · event-stream 2018 · Log4Shell 2021 · colors.js 2022 · xz 2024. Then a single line: *"Maintained by volunteers. Funded by nobody."*

**VO:**
> "Heartbleed. event-stream. Log4Shell. colors.js. The xz backdoor. Every one of these started with a maintainer who was unpaid, overworked, or burnt out. Unfunded open source is a security hole we all share. And today, AI agents use open source more than people do, and they pay nothing."

### 2. Fund agents + sponsor pledge: 0:20–0:50 (30 s)

**SCREEN:** The Upstream web page. Connect BSV Desktop, which shows `mainnet`. Click **Full fan-out**, approve in BSV Desktop, and the txid appears. Cut to WhatsOnChain: one transaction, 62 outputs. Then set the sponsor pool (`POST /pledge`, or the sponsor panel once built).

**VO:**
> "On BSV a wallet is just a key, so every agent gets its own wallet instantly. I fund all 62 agents from my BSV Desktop wallet in one transaction. Here it is on WhatsOnChain. A sponsor pledges a matching pool, and that money stays in the sponsor's own wallet until the round settles. Nobody holds pooled funds."

### 3. Lisa's agent builds the bakery page: 0:50–1:20 (30 s)

**SCREEN:** Terminal: `npm run lisa`. The LLM plans the page and calls `formatDate`, `compressText`, `spellCheck`, `generatePalette`, `secureHash`, and every call prints a payment txid. Open one on WhatsOnChain and point at output 0 (10 sats to the project) and output 1 (`UPSTREAM|round-1|tiny-tls`). Show the finished `lisa-bakery.html`.

**VO:**
> "Lisa asks her AI agent to build a website for her bakery. Every time the agent uses an open-source tool, it pays that project ten satoshis first, automatically. Each payment is tagged on-chain with the round and the project, so anyone can audit it. Lisa vouched for her agent with her wallet's identity key, so her support counts."

### 4. Swarm lights up the galaxy: 1:20–1:40 (20 s)

**SCREEN:** `npm run swarm`. The galaxy fills with white particles flying into project bubbles, and the ticker scrolls txids. The bubbles for small libraries (`stream-utils`, `compress-lite`) grow fastest.

**VO:**
> "Now fifty agents, each with its own owner, doing real work. Hundreds of ten-satoshi payments a minute. Only BSV makes payments this small worth sending. The little libraries everyone depends on and nobody funds light up first."

### 5. Whale vs crowd, then the Sybil attack: 1:40–2:05 (25 s)

**SCREEN:** `npm run whale`. One big blue particle into `tiny-tls`. The tally table shows its `raised` jump while its `match` barely moves. Then `npm run sybil`. Red particles bounce off, and the server log prints `contribution rejected: …` for every one. (The verifier refuses an unknown project, a missing owner signature, or a signature that doesn't verify. The exact reason depends on how the Phase 7 script builds the attack.)

**VO:**
> "A whale drops twenty thousand satoshis on one project. With quadratic funding, the match goes to breadth of support, not size: one owner, no bonus. And an attacker spinning up ten agents with no owner? Every payment is rejected. Matching counts owners, not agents."

### 6. Settle in one click: 2:05–2:25 (20 s)

**SCREEN:** Click **Settle round**, approve in BSV Desktop, and watch the pool fan out into the bubbles. Open WhatsOnChain: one output per project with a match, plus an OP_RETURN with the SHA-256 of the results.

**VO:**
> "The sponsor settles the round in one click, straight from their wallet to every project, with a hash of the results on-chain so anyone can check the math."

### 7. Close: 2:25–2:30 (5 s)

**SCREEN:** Upstream logo. *"Usage becomes the vote."*

**VO:**
> "Usage becomes the vote. Only BSV makes payments this small viable."

---

## Recording checklist

- [ ] `DRY_RUN=false`, server restarted, mode line reads `LIVE`.
- [ ] Agents funded before recording if the fan-out is pre-recorded. Paste the txid in [tx-links.md](tx-links.md).
- [ ] BSV Desktop on mainnet, window positioned so the approval prompt is visible.
- [ ] Terminal font large and the browser zoomed to 125%.
- [ ] WhatsOnChain tabs open: funding, one Lisa contribution, whale, settlement.
- [ ] Say "(demo)" projects aloud once, or show it on screen. They're named after the real incidents, not the real packages.
