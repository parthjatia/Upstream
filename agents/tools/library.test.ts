import { describe, expect, it } from 'vitest'
import { PROJECTS } from '@upstream/shared/projects'
import {
  compressText,
  formatDate,
  generatePalette,
  secureHash,
  spellCheck,
  TOOLS,
  ToolInputError
} from './library.ts'

describe('library tools', () => {
  it('maps each brief tool to its project, and every project exists', () => {
    expect(Object.fromEntries(TOOLS.map(t => [t.name, t.projectId]))).toEqual({
      formatDate: 'stream-utils',
      compressText: 'compress-lite',
      spellCheck: 'log-helper',
      generatePalette: 'color-text',
      secureHash: 'tiny-tls'
    })
    const ids = PROJECTS.map(p => p.id)
    for (const t of TOOLS) expect(ids).toContain(t.projectId)
  })

  it('formatDate formats deterministically in UTC', () => {
    expect(formatDate('2026-11-01', 'long')).toBe('Sunday, November 1, 2026')
    expect(formatDate('2026-11-01', 'short')).toBe('Nov 1, 2026')
    expect(formatDate('2026-11-01', 'iso')).toBe('2026-11-01')
    expect(() => formatDate('not a date')).toThrow(ToolInputError)
  })

  it('compressText collapses whitespace and strips comments', () => {
    const r = compressText('<p>\n  hello   world\n</p>\n<!-- gone -->\n<p>x</p>')
    expect(r.minified).toBe('<p> hello world </p><p>x</p>')
    expect(r.minifiedBytes).toBeLessThan(r.originalBytes)
    expect(r.gzipBytes).toBeGreaterThan(0)
  })

  it('spellCheck fixes known misspellings and keeps case', () => {
    const r = spellCheck('Delicous sourdouh, recieve TEH bread')
    expect(r.corrected).toBe('Delicious sourdough, receive THE bread')
    expect(r.corrections).toHaveLength(4)
  })

  it('generatePalette accepts names and hex, rejects junk', () => {
    const p = generatePalette('bread')
    expect(p.colors.map(c => c.role)).toEqual(['primary', 'primary-dark', 'accent', 'background', 'surface', 'text'])
    for (const c of p.colors) expect(c.hex).toMatch(/^#[0-9a-f]{6}$/)
    expect(generatePalette('#abc').base).toBe('#aabbcc')
    expect(() => generatePalette('blurple')).toThrow(ToolInputError)
  })

  it('secureHash matches the known SHA-256 of "abc"', () => {
    const r = secureHash('abc')
    expect(r.hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(r.integrity).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=')
  })

  it('tool runners validate untrusted input', () => {
    const byName = Object.fromEntries(TOOLS.map(t => [t.name, t]))
    expect(() => byName.spellCheck!.run({})).toThrow(ToolInputError)
    expect(() => byName.spellCheck!.run({ text: 42 })).toThrow(ToolInputError)
    expect(() => byName.formatDate!.run({ date: '2026-01-01', style: 'fancy' })).toThrow(ToolInputError)
    expect(() => byName.secureHash!.run({ text: 'x', algorithm: 'md5' })).toThrow(ToolInputError)
    expect(byName.formatDate!.run({ date: '2026-01-01', style: 'iso' })).toEqual({ formatted: '2026-01-01' })
  })
})
