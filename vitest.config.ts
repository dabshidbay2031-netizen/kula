import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    include: ['tests/**/*.test.{ts,tsx}'],
    /**
     * Vitest's 5s default is per-test wall clock, not CPU time — so with ~50
     * files each standing up its own jsdom in parallel, tests that do no real
     * work were being killed simply for being descheduled. It showed up as a
     * different innocent test failing on every run. Raised to a value that
     * still catches a genuinely hung test but survives a busy machine.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
