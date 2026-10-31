import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['{shared,server,agents,test}/**/*.test.ts'],
    // Phase 1 has no tests yet; Phase 2 adds the quadratic-matching test.
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false
  }
})
