import type { Faro } from "@grafana/faro-web-sdk";
import type { Tracer } from "@opentelemetry/api";
import "unplugin-icons/types/svelte";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  // Defined in our vite config
  declare const __APP_VERSION__: string;

  interface Window {
    faro: Faro;
    tracer: Tracer;
  }

  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

declare module "socket.io-msgpack-parser" {
  export default parser as any;
}

export {};
