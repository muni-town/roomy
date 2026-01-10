import adapterStatic from "@sveltejs/adapter-static";
import adapterNetlify from "@sveltejs/adapter-netlify";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),
  kit: {
    serviceWorker: {
      register: process.env.MODE !== "tauri",
    },
    output: {
      bundleStrategy: "single",
    },
    adapter:
      process.env.NETLIFY == "true"
        ? adapterNetlify()
        : adapterStatic({
          fallback: "index.html",
        }),
  },
};

export default config;
