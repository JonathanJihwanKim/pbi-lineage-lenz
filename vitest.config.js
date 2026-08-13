import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.js', 'apps/*/tests/**/*.test.js'],
    environment: 'node',
  },
});
