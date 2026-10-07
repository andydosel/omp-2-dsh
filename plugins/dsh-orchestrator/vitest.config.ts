import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The sibling plugin packages are workspace links that only exist after the
 * wave's `pnpm install`, so the tests resolve them straight to their sources
 * (the same mapping `tsconfig.json` declares for the type side).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dsh-plugin/dsh-worker-spawn': fileURLToPath(new URL('../dsh-worker-spawn/src/index.ts', import.meta.url)),
      '@dsh-plugin/dsh-worker-spawn/types': fileURLToPath(new URL('../dsh-worker-spawn/src/types.ts', import.meta.url)),
      '@dsh-plugin/dsh-worker-spawn/workers': fileURLToPath(new URL('../dsh-worker-spawn/src/workers.ts', import.meta.url)),
      '@dsh-plugin/dsh-advisor/reviewer': fileURLToPath(new URL('../dsh-advisor/src/reviewer.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
