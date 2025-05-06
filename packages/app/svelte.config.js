import adapterNetlify from "@sveltejs/adapter-netlify";
import adapterStatic from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

const config = {
  preprocess: vitePreprocess(),

  kit: {
    serviceWorker: {
      register: process.env.MODE === "tauri" ? false : true,
    },
    adapter:
      process.env.MODE === "tauri"
        ? adapterStatic({
            fallback: "index.html",
          })
        : adapterNetlify({
            fallback: "index.html",
          }),
  },
};

export default config;
