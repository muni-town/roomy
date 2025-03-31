import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import arraybuffer from "vite-plugin-arraybuffer";
import { SvelteKitPWA } from "@vite-pwa/sveltekit";

export default defineConfig({
  plugins: [
    arraybuffer(),
    wasm(),
    topLevelAwait(),
    sveltekit(),
    tailwindcss(),
    SvelteKitPWA()
  ] as PluginOption[],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2048,
  },
});
