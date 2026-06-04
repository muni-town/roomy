import "unplugin-icons/types/svelte";

declare global {
  // Defined in vite.config.ts
  declare const __APP_VERSION__: string;
  declare const __BUILD_ID__: string | undefined;

  namespace App {}
}

export {};
