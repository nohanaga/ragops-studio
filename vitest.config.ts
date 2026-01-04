import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['src/test/setup.ts'],
    // Keep defaults (node environment) for unit tests.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Start by measuring core logic only; expand later as UI tests land.
      include: ['src/lib/**/*.{ts,tsx}', 'src/utils/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', 'src/**/index.ts'],
      all: true,
    },
  },
})
