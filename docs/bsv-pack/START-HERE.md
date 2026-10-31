# BSV Blockchain — Developer Pack

**TUM Blockchain & AI Hackathon 2026 · BSV Association**

Welcome! This pack has everything you need to build on the BSV Blockchain with a BRC-100 wallet: payments, tokens, NFTs, overlays and pay-per-request APIs. Read this page first.

---

## What is in this pack

| File | What it is for |
|---|---|
| `START-HERE.md` | This page: setup, getting satoshis and contact |
| `BSV_STACK_COMPLETE_GUIDE.md` | **The main reference**: a complete, tested guide to the BSV Blockchain stack, and the context file to give your AI assistant |
| `AGENTS.md` | Rules and package versions for AI coding agents (Claude Code, Cursor, Codex…) |
| `starter/bsv21-token-kit/` | A working starter project: tokens, NFTs, payments, paid APIs and a web UI, with 38 automated tests |

## Suggested order

1. Install the wallet and get satoshis (below).
2. Give your AI assistant `AGENTS.md` and `BSV_STACK_COMPLETE_GUIDE.md`, or read the guide yourself.
3. Run the starter kit and try its flows.

---

## 1. Install the wallet

- **BSV Desktop** (macOS, Windows, Linux): <https://desktop.bsvb.tech>
- **BSV Browser** (iOS, Android): <https://mobile.bsvb.tech>

Create a wallet on **mainnet**. Write your recovery phrase down offline and never share it with anyone.

## 2. Get satoshis

You do not need any API keys. BSV Association provides mainnet satoshis to every team:

1. Open BSV Desktop and go to **Payments → Receive → BSV Address**.
2. Copy the address.
3. Send it, with your **team name**, to **@lexamaison** on Telegram.

We will send satoshis to that address.

> Never share your recovery phrase or private keys with anyone, including us. A BSV address is public and safe to share.

## 3. Run the starter kit

Requirements: Node.js 22+, and BSV Desktop open and unlocked.

```bash
cd starter/bsv21-token-kit
npm install
npm test          # 38 tests, offline (mock chain) — should all pass
npm run overlay   # token overlay on http://localhost:8080
npm run web       # demo UI on http://localhost:5173 (in a second terminal)
```

Open <http://localhost:5173>, click **Connect wallet**, approve in BSV Desktop, and create your first token. Every transaction is real and visible on <https://whatsonchain.com> and <https://bananablocks.com>.

## 4. Build with an AI assistant

- Put `AGENTS.md` at the root of your project (or paste it into your assistant's instructions) and attach `BSV_STACK_COMPLETE_GUIDE.md`.
- Ask for small, testable steps. The guide's Appendix A contains tested code your assistant can copy instead of inventing it.
- Optional community tools for Claude Code: the bOpen plugins `bsv-skills`, `1sat` and `bsv-mcp` (<https://bopen.ai/agents>). They are not maintained by BSV Association.

## 5. Key links

| What | Link |
|---|---|
| BSV TypeScript stack (SDK, Wallet Toolbox, overlays, middleware) | <https://github.com/bsv-blockchain/ts-stack> |
| ts-stack documentation | <https://bsv-blockchain.github.io/ts-stack/> |
| Arcade (broadcast, tx status, block headers — no key needed) | <https://arcade-v2-us-1.bsvblockchain.tech> |
| BRC standards | <https://github.com/bsv-blockchain/BRCs> |
| BSV-21 token spec (1Sat) | <https://docs.1satordinals.com/fungible-tokens/bsv-21> |
| Token explorer | <https://bananablocks.com/tokens> |
| Transaction explorer | <https://whatsonchain.com> |

---

## Contact

Questions about the stack or the starter kit: **@lexamaison** on Telegram (Axel Maisonneuve, BSV Association).

Good luck, and have fun building!
