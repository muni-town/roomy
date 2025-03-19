import * as universal from '../entries/pages/(internal)/_layout.ts.js';

export const index = 2;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/fallbacks/layout.svelte.js')).default;
export { universal };
export const universal_id = "src/routes/(internal)/+layout.ts";
export const imports = ["_app/immutable/nodes/2.BPnlBF5a.js","_app/immutable/nodes/0.CzRkCcfC.js","_app/immutable/chunks/NZTpNUN0.js","_app/immutable/chunks/BMAj9zKA.js","_app/immutable/chunks/DIeogL5L.js","_app/immutable/chunks/pDBoOQRd.js","_app/immutable/chunks/k4NpJaFV.js"];
export const stylesheets = [];
export const fonts = [];
