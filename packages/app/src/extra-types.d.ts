// This is an annoying workaround for the fact that we don't yet know how to get
// TypeScript to resolve the npm identifiers used in the jsr packages.
//
// I think there must be a way to do it, because Vite works fine with this when
// compiling the SvelteKit app, but when running svelte-check, and when the IDE
// is trying to access the module using the project's tsconfig.json file, it
// doesn't actually resolve and says the module isn't found.
declare module "npm:loro-crdt@^1.5.1" {
  export * from "loro-crdt";
}
