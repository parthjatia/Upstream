# Notes from the phase6-lisa session

Changes I wanted outside my files, left for whoever merges:

1. **LLM SDKs instead of raw `fetch`.** `agents/tools/llm.ts` calls the
   Anthropic Messages API and the OpenAI Chat Completions API over plain HTTPS,
   because this session may not add dependencies to `agents/package.json`. To
   switch to the official SDKs, add `@anthropic-ai/sdk` (and `openai` if wanted)
   to `agents/package.json` and replace `anthropicSession` / `openAiSession`;
   nothing else depends on how they talk to the API.

2. **`.env.example`.** I added `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` and
   `LISA_MAX_TOOL_CALLS` as asked. The old `ANTHROPIC_API_KEY` /
   `ANTHROPIC_MODEL` lines are kept and are read as a fallback; they can be
   removed once nobody's `.env` relies on them. Note `ANTHROPIC_MODEL` is
   honoured if set, so an existing `.env` with `claude-sonnet-5` will run on
   that model instead of the default `claude-opus-5-5`.

3. **`test-pay.ts` duplicates the attestation lookup** that now lives in
   `agents/tools/owner.ts` (`resolveLisaOwner`). It could import it.

4. **Live run.** With `DRY_RUN=false` the scripted planner is refused, a key is
   required, and Lisa's owner must be a real BSV Desktop attestation (no
   simulated fallback), exactly like `npm run test-pay`.
