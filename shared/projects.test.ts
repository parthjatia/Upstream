import { P2PKH } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { PROJECT_META } from './projectMeta.ts'
import { PROJECTS, PROJECTS_BY_ADDRESS, findProject } from './projects.ts'

/** Base58 testnet P2PKH addresses start with m or n (mainnet starts with 1). */
const TESTNET_ADDRESS = /^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/

describe('project registry (shared/projects.json)', () => {
  it('has the five demo projects named in PROJECT_BRIEF.md', () => {
    expect(PROJECTS.map(p => p.id)).toEqual([
      'tiny-tls',
      'stream-utils',
      'log-helper',
      'color-text',
      'compress-lite'
    ])
  })

  it('matches the hand-written metadata', () => {
    expect(PROJECTS).toHaveLength(PROJECT_META.length)
    for (const [i, meta] of PROJECT_META.entries()) {
      const p = PROJECTS[i]!
      expect(p.id).toBe(meta.id)
      expect(p.name).toBe(meta.name)
      expect(p.story).toBe(meta.story)
    }
  })

  it('carries a testnet address per project that builds a valid P2PKH lock', () => {
    for (const p of PROJECTS) {
      expect(p.address, p.id).toMatch(TESTNET_ADDRESS)
      const script = new P2PKH().lock(p.address).toHex()
      // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
      expect(script, p.id).toMatch(/^76a914[0-9a-f]{40}88ac$/)
    }
  })

  it('uses a distinct address per project', () => {
    expect(new Set(PROJECTS.map(p => p.address)).size).toBe(PROJECTS.length)
    expect(PROJECTS_BY_ADDRESS.size).toBe(PROJECTS.length)
  })

  it('never leaks private key material into the tracked registry', () => {
    for (const p of PROJECTS) {
      expect(Object.keys(p).sort()).toEqual(['address', 'id', 'name', 'story'])
    }
  })

  it('marks every display name as a demo', () => {
    for (const p of PROJECTS) expect(p.name.endsWith('(demo)'), p.name).toBe(true)
  })

  it('tells the real-world story behind each project', () => {
    for (const p of PROJECTS) expect(p.story.length, p.id).toBeGreaterThan(80)
  })

  it('looks projects up by id and by address', () => {
    const first = PROJECTS[0]!
    expect(findProject(first.id)).toEqual(first)
    expect(findProject('no-such-project')).toBeUndefined()
    expect(PROJECTS_BY_ADDRESS.get(first.address)).toEqual(first)
  })
})
