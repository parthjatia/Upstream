/**
 * The five "open-source libraries" Lisa's agent can use, one per demo project.
 *
 * Each is a small, real, deterministic function — no network, no randomness —
 * so a run can be reproduced and tested. Which project a tool pays is the
 * point of the demo, so the mapping lives right next to the function.
 *
 * Inputs arrive from an LLM as untrusted JSON, so every tool validates its own
 * arguments and throws a ToolInputError with a message the model can act on.
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

export class ToolInputError extends Error {}

/** JSON Schema subset understood by both Anthropic and OpenAI tool calling. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required: string[]
  additionalProperties: false
}

export interface ToolSpec {
  name: string
  /** The project this tool pays on every call. */
  projectId: string
  description: string
  inputSchema: JsonSchema
  run: (input: Record<string, unknown>) => unknown
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function str(input: Record<string, unknown>, key: string, opts: { max?: number; optional?: boolean } = {}): string | undefined {
  const value = input[key]
  if (value === undefined || value === null) {
    if (opts.optional === true) return undefined
    throw new ToolInputError(`"${key}" is required`)
  }
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`)
  const max = opts.max ?? 100_000
  if (value.length > max) throw new ToolInputError(`"${key}" is longer than ${max} characters`)
  return value
}

const reqStr = (input: Record<string, unknown>, key: string, max?: number): string =>
  str(input, key, max === undefined ? {} : { max }) as string

// ---------------------------------------------------------------------------
// formatDate — stream-utils
// ---------------------------------------------------------------------------

export type DateStyle = 'long' | 'short' | 'iso' | 'weekday'
const DATE_STYLES: DateStyle[] = ['long', 'short', 'iso', 'weekday']

export function formatDate(date: string, style: DateStyle = 'long', locale = 'en-US'): string {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) throw new ToolInputError(`"${date}" is not a date`)
  if (style === 'iso') return parsed.toISOString().slice(0, 10)
  const opts: Intl.DateTimeFormatOptions =
    style === 'short'
      ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
      : style === 'weekday'
        ? { weekday: 'long', timeZone: 'UTC' }
        : { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }
  try {
    return new Intl.DateTimeFormat(locale, opts).format(parsed)
  } catch {
    throw new ToolInputError(`"${locale}" is not a supported locale`)
  }
}

// ---------------------------------------------------------------------------
// compressText — compress-lite
// ---------------------------------------------------------------------------

export interface CompressResult {
  /** Whitespace-collapsed text, safe for HTML/CSS (keeps single spaces). */
  minified: string
  originalBytes: number
  minifiedBytes: number
  gzipBytes: number
  /** gzip size / original size, 0..1. */
  ratio: number
}

export function compressText(text: string): CompressResult {
  const minified = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim()
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const gzipBytes = gzipSync(Buffer.from(minified, 'utf8')).length
  return {
    minified,
    originalBytes,
    minifiedBytes: Buffer.byteLength(minified, 'utf8'),
    gzipBytes,
    ratio: originalBytes === 0 ? 0 : Math.round((gzipBytes / originalBytes) * 1000) / 1000
  }
}

// ---------------------------------------------------------------------------
// spellCheck — log-helper
// ---------------------------------------------------------------------------

/** Common English misspellings, plus bakery words people get wrong. */
const MISSPELLINGS: Record<string, string> = {
  acommodate: 'accommodate',
  accomodate: 'accommodate',
  adress: 'address',
  beleive: 'believe',
  bisquit: 'biscuit',
  buisness: 'business',
  cinammon: 'cinnamon',
  cinnamin: 'cinnamon',
  croissan: 'croissant',
  crossaint: 'croissant',
  definately: 'definitely',
  delicous: 'delicious',
  delicios: 'delicious',
  dessers: 'desserts',
  freind: 'friend',
  freshy: 'freshly',
  goverment: 'government',
  ingrediant: 'ingredient',
  ingrediants: 'ingredients',
  occured: 'occurred',
  recieve: 'receive',
  reciept: 'receipt',
  recipie: 'recipe',
  resturant: 'restaurant',
  saturdy: 'saturday',
  seperate: 'separate',
  sourdouh: 'sourdough',
  teh: 'the',
  tommorow: 'tomorrow',
  tomorow: 'tomorrow',
  untill: 'until',
  wednsday: 'wednesday',
  wierd: 'weird'
}

export interface SpellCheckResult {
  corrected: string
  corrections: Array<{ word: string; suggestion: string }>
}

const matchCase = (original: string, replacement: string): string =>
  original === original.toUpperCase() && original.length > 1
    ? replacement.toUpperCase()
    : original[0] === original[0]?.toUpperCase()
      ? replacement[0]!.toUpperCase() + replacement.slice(1)
      : replacement

export function spellCheck(text: string): SpellCheckResult {
  const corrections: SpellCheckResult['corrections'] = []
  const corrected = text.replace(/[A-Za-z]+/g, word => {
    const fix = MISSPELLINGS[word.toLowerCase()]
    if (fix === undefined) return word
    const suggestion = matchCase(word, fix)
    corrections.push({ word, suggestion })
    return suggestion
  })
  return { corrected, corrections }
}

// ---------------------------------------------------------------------------
// generatePalette — color-text
// ---------------------------------------------------------------------------

export interface Palette {
  base: string
  colors: Array<{ role: string; hex: string }>
}

const NAMED_COLORS: Record<string, string> = {
  bread: '#c8893b',
  wheat: '#f5deb3',
  chocolate: '#7b3f00',
  cream: '#fff8e7',
  strawberry: '#e5435a',
  berry: '#8e3a59',
  pistachio: '#93c572',
  caramel: '#c68e17',
  lavender: '#b497d6',
  mint: '#7fcfb0'
}

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (m === null) throw new ToolInputError(`"${hex}" is not a hex colour or a known name`)
  let h = m[1]!
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return [h * 60, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function generatePalette(base: string): Palette {
  const hex = NAMED_COLORS[base.trim().toLowerCase()] ?? base
  const [h, s, l] = rgbToHsl(parseHex(hex))
  const sat = clamp(s, 0.25, 0.85)
  return {
    base: hslToHex(h, s, l),
    colors: [
      { role: 'primary', hex: hslToHex(h, sat, clamp(l, 0.35, 0.55)) },
      { role: 'primary-dark', hex: hslToHex(h, sat, 0.25) },
      { role: 'accent', hex: hslToHex(h + 150, sat, 0.5) },
      { role: 'background', hex: hslToHex(h, clamp(sat, 0, 0.6), 0.96) },
      { role: 'surface', hex: hslToHex(h, clamp(sat, 0, 0.5), 0.9) },
      { role: 'text', hex: hslToHex(h, 0.2, 0.15) }
    ]
  }
}

// ---------------------------------------------------------------------------
// secureHash — tiny-tls
// ---------------------------------------------------------------------------

export type HashAlgorithm = 'sha256' | 'sha384' | 'sha512'
const HASH_ALGORITHMS: HashAlgorithm[] = ['sha256', 'sha384', 'sha512']

export interface HashResult {
  algorithm: HashAlgorithm
  hex: string
  /** Subresource-Integrity form, e.g. "sha256-…base64…". */
  integrity: string
}

export function secureHash(text: string, algorithm: HashAlgorithm = 'sha256'): HashResult {
  const digest = createHash(algorithm).update(text, 'utf8').digest()
  return {
    algorithm,
    hex: digest.toString('hex'),
    integrity: `${algorithm}-${digest.toString('base64')}`
  }
}

// ---------------------------------------------------------------------------
// The tool table the agent sees
// ---------------------------------------------------------------------------

const schema = (
  properties: JsonSchema['properties'],
  required: string[]
): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false })

export const TOOLS: ToolSpec[] = [
  {
    name: 'formatDate',
    projectId: 'stream-utils',
    description:
      'Format a date for display, e.g. opening dates or "last updated" lines. ' +
      'Styles: long ("Saturday, November 1, 2026"), short ("Nov 1, 2026"), iso ("2026-11-01"), weekday ("Saturday").',
    inputSchema: schema(
      {
        date: { type: 'string', description: 'Any date string JavaScript can parse, e.g. "2026-11-01".' },
        style: { type: 'string', enum: DATE_STYLES },
        locale: { type: 'string', description: 'BCP 47 locale, default en-US.' }
      },
      ['date']
    ),
    run: input => {
      const style = str(input, 'style', { optional: true, max: 20 }) ?? 'long'
      if (!DATE_STYLES.includes(style as DateStyle)) {
        throw new ToolInputError(`"style" must be one of ${DATE_STYLES.join(', ')}`)
      }
      return {
        formatted: formatDate(
          reqStr(input, 'date', 100),
          style as DateStyle,
          str(input, 'locale', { optional: true, max: 35 }) ?? 'en-US'
        )
      }
    }
  },
  {
    name: 'compressText',
    projectId: 'compress-lite',
    description:
      'Minify HTML/CSS/text (collapses whitespace, strips HTML comments) and report the gzip size. ' +
      'Use it on the finished page before saving.',
    inputSchema: schema({ text: { type: 'string' } }, ['text']),
    run: input => compressText(reqStr(input, 'text'))
  },
  {
    name: 'spellCheck',
    projectId: 'log-helper',
    description: 'Check English copy for common misspellings. Returns the corrected text and a list of fixes.',
    inputSchema: schema({ text: { type: 'string' } }, ['text']),
    run: input => spellCheck(reqStr(input, 'text'))
  },
  {
    name: 'generatePalette',
    projectId: 'color-text',
    description:
      'Generate a harmonious six-colour palette (primary, primary-dark, accent, background, surface, text) ' +
      `from a base hex colour or one of: ${Object.keys(NAMED_COLORS).join(', ')}.`,
    inputSchema: schema(
      { base: { type: 'string', description: 'Hex like "#c8893b" or a name like "bread".' } },
      ['base']
    ),
    run: input => generatePalette(reqStr(input, 'base', 40))
  },
  {
    name: 'secureHash',
    projectId: 'tiny-tls',
    description:
      'Hash text with SHA-2. Returns hex and a Subresource-Integrity string, e.g. to fingerprint the page content.',
    inputSchema: schema(
      { text: { type: 'string' }, algorithm: { type: 'string', enum: HASH_ALGORITHMS } },
      ['text']
    ),
    run: input => {
      const algorithm = str(input, 'algorithm', { optional: true, max: 10 }) ?? 'sha256'
      if (!HASH_ALGORITHMS.includes(algorithm as HashAlgorithm)) {
        throw new ToolInputError(`"algorithm" must be one of ${HASH_ALGORITHMS.join(', ')}`)
      }
      return secureHash(reqStr(input, 'text'), algorithm as HashAlgorithm)
    }
  }
]

export const PAID_TOOL_NAMES = TOOLS.map(t => t.name)

export { reqStr as readString }
