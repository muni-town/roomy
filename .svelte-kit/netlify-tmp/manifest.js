export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set(["favicon.png"]),
	mimeTypes: {".png":"image/png"},
	_: {
		client: {start:"_app/immutable/entry/start.Pts12a4f.js",app:"_app/immutable/entry/app.C3wonWWI.js",imports:["_app/immutable/entry/start.Pts12a4f.js","_app/immutable/chunks/BNjT_JuR.js","_app/immutable/chunks/BqahWDdA.js","_app/immutable/chunks/BMAj9zKA.js","_app/immutable/chunks/DIeogL5L.js","_app/immutable/chunks/Dxu-ImQV.js","_app/immutable/entry/app.C3wonWWI.js","_app/immutable/chunks/BMAj9zKA.js","_app/immutable/chunks/DIeogL5L.js","_app/immutable/chunks/DzGbYseb.js","_app/immutable/chunks/BSdt-dIf.js","_app/immutable/chunks/pDBoOQRd.js","_app/immutable/chunks/NZTpNUN0.js","_app/immutable/chunks/BA1UOs1h.js","_app/immutable/chunks/BUHZJKy3.js","_app/immutable/chunks/Baj-A2iI.js","_app/immutable/chunks/D_-9kNr4.js","_app/immutable/chunks/Dxu-ImQV.js","_app/immutable/chunks/BqahWDdA.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('../output/server/nodes/0.js')),
			__memo(() => import('../output/server/nodes/1.js')),
			__memo(() => import('../output/server/nodes/2.js')),
			__memo(() => import('../output/server/nodes/3.js')),
			__memo(() => import('../output/server/nodes/4.js')),
			__memo(() => import('../output/server/nodes/5.js')),
			__memo(() => import('../output/server/nodes/6.js')),
			__memo(() => import('../output/server/nodes/7.js')),
			__memo(() => import('../output/server/nodes/8.js')),
			__memo(() => import('../output/server/nodes/9.js')),
			__memo(() => import('../output/server/nodes/10.js')),
			__memo(() => import('../output/server/nodes/11.js'))
		],
		routes: [
			{
				id: "/(app)",
				pattern: /^\/?$/,
				params: [],
				page: { layouts: [0,3,], errors: [1,,], leaf: 6 },
				endpoint: null
			},
			{
				id: "/(app)/dev",
				pattern: /^\/dev\/?$/,
				params: [],
				page: { layouts: [0,3,], errors: [1,,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/(app)/home",
				pattern: /^\/home\/?$/,
				params: [],
				page: { layouts: [0,3,], errors: [1,,], leaf: 7 },
				endpoint: null
			},
			{
				id: "/(internal)/oauth/callback",
				pattern: /^\/oauth\/callback\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 5 },
				endpoint: null
			},
			{
				id: "/(app)/space/[space]",
				pattern: /^\/space\/([^/]+?)\/?$/,
				params: [{"name":"space","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,3,4,], errors: [1,,,], leaf: 9 },
				endpoint: null
			},
			{
				id: "/(app)/space/[space]/thread/[thread]",
				pattern: /^\/space\/([^/]+?)\/thread\/([^/]+?)\/?$/,
				params: [{"name":"space","optional":false,"rest":false,"chained":false},{"name":"thread","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,3,4,], errors: [1,,,], leaf: 11 },
				endpoint: null
			},
			{
				id: "/(app)/space/[space]/[channel]",
				pattern: /^\/space\/([^/]+?)\/([^/]+?)\/?$/,
				params: [{"name":"space","optional":false,"rest":false,"chained":false},{"name":"channel","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,3,4,], errors: [1,,,], leaf: 10 },
				endpoint: null
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
