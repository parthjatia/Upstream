import { describe, expect, it } from 'vitest'
import {
  ARCADE_MAINNET,
  DEFAULT_PORT,
  EXPLORER_MAINNET,
  describeMode,
  loadRuntime,
  readDryRun,
  readPort
} from './runtime.ts'

describe('readPort', () => {
  it('defaults to 8787', () => {
    expect(DEFAULT_PORT).toBe(8787)
    expect(readPort(undefined)).toBe(8787)
    expect(readPort('')).toBe(8787)
    expect(readPort('   ')).toBe(8787)
  })

  it('reads a port from the environment', () => {
    expect(readPort('3000')).toBe(3000)
    expect(readPort(' 9999 ')).toBe(9999)
    expect(readPort('65535')).toBe(65_535)
    expect(readPort('1')).toBe(1)
  })

  it('refuses something that is not a port', () => {
    expect(() => readPort('abc')).toThrow(/not a number/)
    expect(() => readPort('80.5')).toThrow(/not a number/)
    expect(() => readPort('-1')).toThrow(/not a number/)
    expect(() => readPort('0')).toThrow(/valid range/)
    expect(() => readPort('65536')).toThrow(/valid range/)
  })
})

describe('loadRuntime', () => {
  it('defaults the server URL to localhost on PORT', () => {
    expect(loadRuntime({}).serverUrl).toBe('http://localhost:8787')
    expect(loadRuntime({ PORT: '9100' }).serverUrl).toBe('http://localhost:9100')
  })

  it('uses PORT for the server and for where agents report', () => {
    const r = loadRuntime({ PORT: '4242' })
    expect(r.port).toBe(4242)
    expect(r.serverUrl).toBe('http://localhost:4242')
  })

  it('lets SERVER_URL override the default', () => {
    const r = loadRuntime({ PORT: '8787', SERVER_URL: 'http://10.0.0.5:9000' })
    expect(r.port).toBe(8787) // the server still listens here
    expect(r.serverUrl).toBe('http://10.0.0.5:9000') // agents report there
  })

  it('trims a trailing slash so paths do not double up', () => {
    expect(loadRuntime({ SERVER_URL: 'http://localhost:8787/' }).serverUrl).toBe(
      'http://localhost:8787'
    )
    expect(loadRuntime({ ARCADE_URL: `${ARCADE_MAINNET}/` }).arcadeUrl).toBe(ARCADE_MAINNET)
  })

  it('defaults the rest to mainnet and round-1', () => {
    const r = loadRuntime({})
    expect(r.network).toBe('mainnet')
    expect(r.round).toBe('round-1')
    expect(r.arcadeUrl).toBe(ARCADE_MAINNET)
    expect(r.explorerTxUrl).toBe(EXPLORER_MAINNET)
  })

  it('defaults to dry-run', () => {
    expect(loadRuntime({}).dryRun).toBe(true)
    expect(readDryRun(undefined)).toBe(true)
  })

  it('propagates a bad PORT rather than falling back silently', () => {
    expect(() => loadRuntime({ PORT: 'eighty' })).toThrow(/PORT/)
  })

  it('describes each mode in one line', () => {
    expect(describeMode(loadRuntime({ DRY_RUN: 'true' }))).toMatch(/DRY RUN/)
    expect(describeMode(loadRuntime({ DRY_RUN: 'false' }))).toMatch(/LIVE/)
    expect(describeMode(loadRuntime({ DRY_RUN: 'false' }))).toContain(ARCADE_MAINNET)
  })

  it('supports two sessions side by side', () => {
    // What the parallel-session setup needs: different ports, each agent run
    // reporting to its own server.
    const a = loadRuntime({ PORT: '8787' })
    const b = loadRuntime({ PORT: '8788' })
    expect(a.port).not.toBe(b.port)
    expect(a.serverUrl).not.toBe(b.serverUrl)
  })
})
