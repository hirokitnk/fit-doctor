import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // In-process tests run against core's sources; the spawned-binary test uses the build.
    alias: { '@fit-doctor/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
});
