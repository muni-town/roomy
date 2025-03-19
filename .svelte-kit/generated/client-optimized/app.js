import * as client_hooks from '../../../src/hooks.client.ts';


export { matchers } from './matchers.js';

export const nodes = [
	() => import('./nodes/0'),
	() => import('./nodes/1'),
	() => import('./nodes/2'),
	() => import('./nodes/3'),
	() => import('./nodes/4'),
	() => import('./nodes/5'),
	() => import('./nodes/6'),
	() => import('./nodes/7'),
	() => import('./nodes/8'),
	() => import('./nodes/9'),
	() => import('./nodes/10'),
	() => import('./nodes/11')
];

export const server_loads = [];

export const dictionary = {
		"/(app)": [6,[3]],
		"/(app)/dev": [8,[3]],
		"/(app)/home": [7,[3]],
		"/(internal)/oauth/callback": [5,[2]],
		"/(app)/space/[space]": [9,[3,4]],
		"/(app)/space/[space]/thread/[thread]": [11,[3,4]],
		"/(app)/space/[space]/[channel]": [10,[3,4]]
	};

export const hooks = {
	handleError: client_hooks.handleError || (({ error }) => { console.error(error) }),
	init: client_hooks.init,
	reroute: (() => {}),
	transport: {}
};

export const decoders = Object.fromEntries(Object.entries(hooks.transport).map(([k, v]) => [k, v.decode]));

export const hash = false;

export const decode = (type, value) => decoders[type](value);

export { default as root } from '../root.js';