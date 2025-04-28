import { defineConfig } from 'vitest/config';
import path from 'path';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import arraybuffer from 'vite-plugin-arraybuffer';

export default defineConfig({
  plugins: [
    arraybuffer(),
    wasm(),
    topLevelAwait(),
    sveltekit(),
    tailwindcss(),
  ],
  test: {
    globals: true,
    setupFiles: './vitest.setup.ts',
    alias: {
      '$app/navigation': path.resolve(__dirname, '__mocks__/$app/navigation.ts'),
      '$lib': path.resolve(__dirname, 'src/lib'),
    },
    environment: 'jsdom',
  },
});
