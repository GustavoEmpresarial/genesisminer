import { defineConfig } from 'vitest/config';

/**
 * Suíte de integração PG (concorrência real). Não entra no `npm test` default.
 * Corrida: `npm run test:pg-integration`
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/pg/**/*.test.ts'],
    setupFiles: ['tests/integration/pg/setup-env.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
