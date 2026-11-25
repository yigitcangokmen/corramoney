import { defineConfig } from 'vitest/config';

/** The live UI-path check against the local stack (pnpm local:check). The default `vitest run` never picks up .live.ts. */
export default defineConfig({ test: { include: ['src/live/**/*.live.ts'], testTimeout: 300_000, hookTimeout: 120_000 } });
