import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // pglite (WASM Postgres) per test file is memory hungry; unbounded forks crash workers on small machines.
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
  },
});
