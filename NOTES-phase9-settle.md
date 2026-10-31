# Notes from the phase9-settle session

## Changes outside my listed files

1. **`server/src/index.ts`: 4 added lines, nothing else changed.** The task needs
   `GET /settlement/preview` to work now, so the router has to be mounted:
   ```ts
   import { settlementRouter } from './settlementRoutes.ts'
   app.use(settlementRouter({ round: ROUND, network: NETWORK, serverDryRun: runtime.dryRun, pool }))
   ```
   If this conflicts in the merge, keep both sides. The line goes before `/events`.

2. **`web/src/App.tsx`: 2 lines** (import + `<SettlementPanel conn={conn} />`), as the task allowed.

## Suggestions for later (not done here)

- `server/src/settlementCore.ts` is browser-safe, and `web/src/SettlementPanel.tsx`
  imports it with `../../server/src/settlementCore`, so the browser rebuilds the
  outputs itself instead of signing what the server sent. Its natural home is
  `shared/settlement.ts` (with an `exports` entry in `shared/package.json`).
  I didn't move it because `shared/` isn't in my file list.
- `scripts/` is not in the root `tsconfig.json` `include`, so `npx tsc --noEmit`
  does not check `scripts/demo-check.ts`. I checked it on its own. Add `"scripts"`
  to `include` to cover it.
- `server/src/index.ts` header comment says "Phase 9 adds POST /settlement"; it
  now exists (in `settlementRoutes.ts`), and `/health` still reports `phase: 5`.
- The galaxy (Phase 8) can animate the pool fan-out from the `settled` SSE event,
  which this branch now emits with the settled rows.
