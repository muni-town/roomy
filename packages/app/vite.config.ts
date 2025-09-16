import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type PluginOption } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [
    sveltekit(),
    tailwindcss(),
    topLevelAwait(),
    wasm(),
    {
      // Add stricter headers that will allow the browser to enable SharedArrayBuffers in
      // workers, which is used by the SQLite VFS.
      name: "cross-origin-isolation-headers",
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Permissions-Policy", "cross-origin-isolated=*");
          next();
        });
      },
    },
  ] as PluginOption[],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2048,
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
  },
  optimizeDeps: {
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
});
