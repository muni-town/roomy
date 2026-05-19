import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit(),
    tailwindcss(),
    Icons({
      compiler: "svelte",
      customCollections: {
        custom: FileSystemIconLoader("../design/static/icons"),
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5180,
  },
});
