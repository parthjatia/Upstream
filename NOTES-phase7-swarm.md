# Notes from phase7-swarm

Things outside this branch's files that the merge (or a later phase) should know.

1. **Do not run `swarm`, `whale` and `sybil` at the same time in separate
   processes.** `agents/lib/utxos.ts` `putUtxo` rewrites the whole
   `data/utxos.json` (read, modify, write). Inside one process that is safe, as
   the swarm runs all its agents in one process. Across processes, one write can
   undo another, and an agent could then reuse a spent output (live: Arcade
   rejects it as a double spend). Running them one after another is fine. A
   per-agent file or a lock in `utxos.ts` would fix it; I did not change it
   because the file is shared.

2. `.env.example` gained `SWARM_DURATION_SEC` and `SWARM_DELAY_MS` (as the
   session prompt asked). Neither is required: the defaults are 120 s and
   500-2000 ms.

3. Sybil contributions are rejected first for `unknown project "totally-legit"`.
   The no-owner check also rejects them; a test covers a sybil on a real
   project to prove that.

4. Budget at the default timing: a swarm agent spends about 11 sats per call
   (10 + 1 fee) and averages about 0.6 calls/s (measured), so 120 s uses about 800 of
   its 1,500 sats. An agent that runs out stops cleanly.
