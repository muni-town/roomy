import adapter from "@sveltejs/adapter-netlify";
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
        : adapter({
            fallback: "index.html",
          }),
  },
};

export default config;
