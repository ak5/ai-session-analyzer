import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // run tests against src so no build step is needed first
    alias: {
      '@asa/core': pkg('core'),
      '@asa/claude-sessions': pkg('claude-sessions'),
      '@asa/codex-sessions': pkg('codex-sessions'),
      '@asa/analyze': pkg('analyze'),
      '@asa/prompter': pkg('prompter'),
      '@asa/distill': pkg('distill'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
