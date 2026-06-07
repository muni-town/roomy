import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import { defineConfig } from "vite";
import packageJson from "./package.json";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __BUILD_ID__: process.env.BUILD_ID
      ? JSON.stringify(process.env.BUILD_ID)
      : "undefined",
  },
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
