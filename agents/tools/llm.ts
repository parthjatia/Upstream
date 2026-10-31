/**
 * A small provider-neutral tool-calling loop over two LLM APIs.
 *
 * Settings come from .env:
 *   LLM_PROVIDER   anthropic | openai   (default: anthropic)
 *   LLM_API_KEY    the provider's API key — never printed, never logged
 *   LLM_MODEL      optional model override (default: see DEFAULT_MODELS)
 *
 * These three names are the only ones read. Provider-specific aliases such as
 * ANTHROPIC_API_KEY are not accepted, so there is exactly one place to look
 * when Lisa runs on the wrong model or cannot authenticate.
 *
 * Both providers are called over plain HTTPS with `fetch`. This session may not
 * add dependencies to the workspace (see NOTES-phase6-lisa.md); swapping in the
 * official SDKs later only touches this file.
 *
 * With no key and DRY_RUN on, the agent falls back to a SCRIPTED planner (see
 * scripted.ts) so the payment flow can be exercised end to end. It says so
 * loudly: a scripted run is not an AI agent and does not satisfy Phase 6.
 */

export type ProviderName = 'anthropic' | 'openai' | 'scripted'

export interface LlmConfig {
  provider: ProviderName
  /** Secret. Never print it; use describeLlm() for logs. */
  apiKey: string
  model: string
  baseUrl: string
  /** Why we are on this provider, for the log (e.g. "no LLM_API_KEY"). */
  reason?: string
}

export const DEFAULT_MODELS: Record<Exclude<ProviderName, 'scripted'>, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-5'
}

const BASE_URLS: Record<Exclude<ProviderName, 'scripted'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com'
}

type Env = Record<string, string | undefined>

export class LlmError extends Error {}

const clean = (v: string | undefined): string => (v ?? '').trim()

export function loadLlmConfig(env: Env, opts: { dryRun: boolean }): LlmConfig {
  const raw = clean(env.LLM_PROVIDER).toLowerCase()
  if (raw !== '' && raw !== 'anthropic' && raw !== 'openai' && raw !== 'scripted') {
    throw new LlmError(`LLM_PROVIDER="${raw}" is not supported (use anthropic or openai).`)
  }
  const provider = (raw === '' ? 'anthropic' : raw) as ProviderName

  if (provider === 'scripted') {
    if (!opts.dryRun) throw new LlmError('LLM_PROVIDER=scripted is only allowed with DRY_RUN=true.')
    return { provider, apiKey: '', model: 'scripted', baseUrl: '', reason: 'LLM_PROVIDER=scripted' }
  }

  // One name for every provider. Provider-specific names (ANTHROPIC_API_KEY,
  // OPENAI_API_KEY) are deliberately NOT read: two ways to set the same thing
  // is how a .env ends up running a model nobody chose.
  const apiKey = clean(env.LLM_API_KEY)

  if (apiKey === '') {
    if (opts.dryRun) {
      return {
        provider: 'scripted',
        apiKey: '',
        model: 'scripted',
        baseUrl: '',
        reason: `no LLM_API_KEY in .env (LLM_PROVIDER=${provider})`
      }
    }
    throw new LlmError('LLM_API_KEY is empty. Set it in .env (it is gitignored) to run Lisa live.')
  }

  const model = clean(env.LLM_MODEL) || DEFAULT_MODELS[provider]

  return {
    provider,
    apiKey,
    model,
    baseUrl: (clean(env.LLM_BASE_URL) || BASE_URLS[provider]).replace(/\/$/, '')
  }
}

/** Safe one-liner for logs: never contains the key. */
export const describeLlm = (c: LlmConfig): string =>
  c.provider === 'scripted'
    ? `SCRIPTED planner, not an LLM (${c.reason ?? 'dry run'})`
    : `${c.provider} · ${c.model} · key ${c.apiKey === '' ? 'missing' : 'set'}`

// ---------------------------------------------------------------------------
// The neutral loop interface
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  /** Set when the model's arguments were not valid JSON. */
  parseError?: string
}

export interface ToolOutcome {
  id: string
  /** JSON or plain text handed back to the model. */
  content: string
  isError: boolean
}

export type StopKind = 'tool_use' | 'end' | 'max_tokens' | 'refusal'

export interface Turn {
  text: string
  calls: ToolCall[]
  stop: StopKind
}

export interface LlmSession {
  /** First turn, from the task prompt. */
  start(): Promise<Turn>
  /** Hand back every result for the previous turn's calls, in one message. */
  continue(results: ToolOutcome[]): Promise<Turn>
}

export interface SessionInit {
  system: string
  task: string
  tools: ToolDef[]
  /** Injected for tests. */
  fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// HTTP with a small retry for 429 / 5xx / network errors
// ---------------------------------------------------------------------------

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string
): Promise<unknown> {
  let lastErr = ''
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
      })
    } catch (err) {
      lastErr = `network error: ${(err as Error).message}`
      continue
    }
    const text = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw new LlmError(`${label} returned non-JSON: ${text.slice(0, 200)}`)
      }
    }
    lastErr = `${res.status}: ${text.slice(0, 400)}`
    if (res.status !== 429 && res.status < 500) break
  }
  throw new LlmError(`${label} request failed (${lastErr})`)
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'])

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}
interface AnthropicResponse {
  content?: AnthropicBlock[]
  stop_reason?: string
}

export function anthropicSession(cfg: LlmConfig, init: SessionInit): LlmSession {
  const fetchImpl = init.fetchImpl ?? fetch
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: init.task }
  ]
  const tools = init.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }))
  const fallback = FALLBACK_MODELS.has(cfg.model)

  const call = async (): Promise<Turn> => {
    const headers: Record<string, string> = {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01'
    }
    if (fallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: 16_000,
      system: init.system,
      tools,
      messages
    }
    if (fallback) body.fallbacks = 'default'

    const res = (await postJson(fetchImpl, `${cfg.baseUrl}/v1/messages`, headers, body, 'Anthropic')) as AnthropicResponse
    const content = res.content ?? []
    // Append the full content unchanged (thinking blocks included).
    messages.push({ role: 'assistant', content })

    const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim()
    const calls: ToolCall[] = content
      .filter(b => b.type === 'tool_use')
      .map(b => ({
        id: b.id ?? '',
        name: b.name ?? '',
        input: (b.input !== null && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>
      }))
    const stop: StopKind =
      res.stop_reason === 'refusal'
        ? 'refusal'
        : res.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : calls.length > 0
            ? 'tool_use'
            : 'end'
    return { text, calls, stop }
  }

  return {
    start: call,
    continue: async results => {
      messages.push({
        role: 'user',
        content: results.map(r => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {})
        }))
      })
      return await call()
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API
// ---------------------------------------------------------------------------

interface OpenAiToolCall {
  id: string
  type: string
  function?: { name?: string; arguments?: string }
}
interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { role: string; content?: string | null; tool_calls?: OpenAiToolCall[]; refusal?: string | null }
  }>
}

export function openAiSession(cfg: LlmConfig, init: SessionInit): LlmSession {
  const fetchImpl = init.fetchImpl ?? fetch
  const messages: unknown[] = [
    { role: 'system', content: init.system },
    { role: 'user', content: init.task }
  ]
  const tools = init.tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }))

  const call = async (): Promise<Turn> => {
    const res = (await postJson(
      fetchImpl,
      `${cfg.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${cfg.apiKey}` },
      { model: cfg.model, messages, tools, max_completion_tokens: 16_000 },
      'OpenAI'
    )) as OpenAiResponse
    const choice = res.choices?.[0]
    const message = choice?.message
    if (message === undefined) throw new LlmError('OpenAI returned no message')
    messages.push(message)

    const calls: ToolCall[] = (message.tool_calls ?? [])
      .filter(c => c.type === 'function')
      .map(c => {
        const raw = c.function?.arguments ?? '{}'
        try {
          const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw)
          const input = (parsed !== null && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>
          return { id: c.id, name: c.function?.name ?? '', input }
        } catch (err) {
          return { id: c.id, name: c.function?.name ?? '', input: {}, parseError: (err as Error).message }
        }
      })
    const stop: StopKind =
      message.refusal != null || choice?.finish_reason === 'content_filter'
        ? 'refusal'
        : choice?.finish_reason === 'length'
          ? 'max_tokens'
          : calls.length > 0
            ? 'tool_use'
            : 'end'
    return { text: (message.content ?? message.refusal ?? '').trim(), calls, stop }
  }

  return {
    start: call,
    continue: async results => {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
      return await call()
    }
  }
}
