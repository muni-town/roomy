import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    include: ["src/**/*.spec.ts"],
    exclude: ["node_modules", "dist"],
  },
});
