import adapterStatic from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),

  kit: {
    serviceWorker: {
      register: process.env.MODE !== "tauri",
    },
    adapter: adapterStatic({
      fallback: "index.html",
    }),
  },
};

export default config;
