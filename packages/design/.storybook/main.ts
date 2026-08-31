import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/svelte-vite";

const thisDir = dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|svelte)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-themes",
    "@storybook/addon-svelte-csf",
  ],
  framework: {
    name: "@storybook/svelte-vite",
    options: {
      // The svelte-vite docgen transform parses compiled Svelte output and
      // crashes on .stories.svelte files ("Expression expected"). Story
      // controls/args come from addon-svelte-csf, so docgen adds nothing here.
      docgen: false,
    },
  },
  core: {
    disableTelemetry: true,
  },
  viteFinal: async (viteConfig) => {
    // Dynamic imports: @tailwindcss/vite, unplugin-icons and
    // @sveltejs/vite-plugin-svelte are ESM-only and cannot be loaded by
    // Storybook's CJS config loader at the top level.
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    const { default: Icons } = await import("unplugin-icons/vite");
    const { FileSystemIconLoader } = await import("unplugin-icons/loaders");
    // Storybook 9's svelte-vite framework no longer injects the Svelte
    // compiler plugin. It MUST run before addon-svelte-csf's transform
    // (both are enforce:'pre' — Vite orders same-enforce plugins by
    // registration order), otherwise .stories.svelte files reach the addon
    // as raw markup and fail to parse. Hence prepend, not mergeConfig.
    const { svelte } = await import("@sveltejs/vite-plugin-svelte");

    const extraPlugins = [
      svelte(),
      tailwindcss(),
      Icons({
        compiler: "svelte",
        customCollections: {
          custom: FileSystemIconLoader(resolve(thisDir, "../static/icons")),
        },
      }),
    ];

    return {
      ...viteConfig,
      plugins: [...extraPlugins, ...(viteConfig.plugins ?? [])],
      optimizeDeps: {
        ...(viteConfig.optimizeDeps ?? {}),
        // @foxui/core imports `$app/environment`; Vite's esbuild dep
        // optimizer can't apply resolve.alias (and esbuild `alias` needs
        // bundle mode, which Storybook disables here). Excluding it serves
        // the raw module through the normal pipeline, where the alias works.
        exclude: [
          ...(viteConfig.optimizeDeps?.exclude ?? []),
          "@foxui/core",
          "@foxui/social",
        ],
      },
      resolve: {
        ...viteConfig.resolve,
        alias: [
          // Design components must render in isolation — no SvelteKit runtime.
          { find: "$app", replacement: resolve(thisDir, "app-stubs") },
          ...(viteConfig.resolve?.alias ?? []),
        ],
      },
    };
  },
};

export default config;
