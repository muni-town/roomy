import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import arraybuffer from "vite-plugin-arraybuffer";

export default defineConfig({
  plugins: [
    arraybuffer(),
    wasm(),
    topLevelAwait(),
    sveltekit(),
    tailwindcss(),
  ] as PluginOption[],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2048,
    minify: false,
  },
});
