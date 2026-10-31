import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', webhooks: 'src/webhooks.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
