/**
 * `npm run keys` — generate every key the demo needs.
 *
 * Counts come from PROJECT_BRIEF.md Phase 2:
 *   5 projects · 1 Lisa agent · 100 swarm agents + 100 swarm owners
 *   1 whale agent + owner · 20 sybil agents (no owners, by design)
 *
 * Writes `keys/*.json` (gitignored, secret) and merges the generated testnet
 * addresses into `shared/projects.json` (tracked, public).
 *
 * Refuses to overwrite existing keys unless `--force` is passed: once Phase 3
 * has funded these addresses, regenerating them would strand real testnet
 * satoshis in keys nobody holds any more.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_META } from '@upstream/shared/projectMeta'
import type { Project } from '@upstream/shared'
import {
  generateKey,
  keyFileExists,
  writeKeyFile,
  ROOT,
  type AgentWithOwner,
  type KeyRecord
} from './lib/keystore.ts'

const SWARM_SIZE = 100
const SYBIL_SIZE = 20
const FILES = ['projects', 'lisa', 'swarm', 'whale', 'sybil'] as const

const force = process.argv.includes('--force')
const existing = FILES.filter(keyFileExists)

if (existing.length > 0 && !force) {
  console.error(`Keys already exist: ${existing.map(f => `keys/${f}.json`).join(', ')}`)
  console.error('')
  console.error('Refusing to overwrite. If these addresses have been funded, regenerating')
  console.error('them strands those satoshis. Pass --force if you really mean it:')
  console.error('')
  console.error('    npm run keys -- --force')
  process.exit(1)
}

const pad = (n: number): string => String(n).padStart(3, '0')

/** An agent and the owner identity that vouches for it. */
const agentWithOwner = (kind: string, i?: number): AgentWithOwner => {
  const suffix = i === undefined ? '' : `-${pad(i)}`
  return {
    agent: generateKey(`${kind}-agent${suffix}`),
    owner: generateKey(`${kind}-owner${suffix}`)
  }
}

const projects: KeyRecord[] = PROJECT_META.map(m => generateKey(m.id))
const lisa = generateKey('lisa-agent')
const swarm = Array.from({ length: SWARM_SIZE }, (_, i) => agentWithOwner('swarm', i + 1))
const whale = agentWithOwner('whale')
// No owner keys: a sybil agent is unvouched, which is the whole point.
const sybil = Array.from({ length: SYBIL_SIZE }, (_, i) => generateKey(`sybil-agent-${pad(i + 1)}`))

writeKeyFile('projects', projects)
writeKeyFile('lisa', lisa)
writeKeyFile('swarm', swarm)
writeKeyFile('whale', whale)
writeKeyFile('sybil', sybil)

// shared/projects.json: metadata + generated address. Addresses are public.
const registry: Project[] = PROJECT_META.map((meta, i) => {
  const key = projects[i]
  if (!key) throw new Error(`no key generated for project ${meta.id}`)
  return { id: meta.id, name: meta.name, address: key.address, story: meta.story }
})

const registryPath = join(ROOT, 'shared', 'projects.json')
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')

const total = projects.length + 1 + swarm.length * 2 + 2 + sybil.length

console.log('Generated testnet keys:')
console.log(`  keys/projects.json   ${projects.length} project keys`)
console.log(`  keys/lisa.json       1 agent key (owner = Lisa's BSV Desktop identity)`)
console.log(`  keys/swarm.json      ${swarm.length} agents + ${swarm.length} owners`)
console.log(`  keys/whale.json      1 agent + 1 owner`)
console.log(`  keys/sybil.json      ${sybil.length} agents, no owners (will be rejected)`)
console.log(`  ${total} keys total`)
console.log('')
console.log(`Wrote ${registry.length} addresses to shared/projects.json:`)
for (const p of registry) console.log(`  ${p.id.padEnd(14)} ${p.address}`)
console.log('')
console.log('keys/ is gitignored. Never commit it, never share these keys.')
