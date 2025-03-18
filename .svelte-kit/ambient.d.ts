
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * Environment variables [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env`. Like [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), this module cannot be imported into client-side code. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * _Unlike_ [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), the values exported from this module are statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * ```ts
 * import { API_KEY } from '$env/static/private';
 * ```
 * 
 * Note that all environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * 
 * ```
 * MY_FEATURE_FLAG=""
 * ```
 * 
 * You can override `.env` values from the command line like so:
 * 
 * ```bash
 * MY_FEATURE_FLAG="enabled" npm run dev
 * ```
 */
declare module '$env/static/private' {
	export const USER: string;
	export const XPC_SERVICE_NAME: string;
	export const FPATH: string;
	export const HOMEBREW_CELLAR: string;
	export const HOMEBREW_PREFIX: string;
	export const LSCOLORS: string;
	export const TERM: string;
	export const PAGER: string;
	export const SHLVL: string;
	export const TMUX_PLUGIN_MANAGER_PATH: string;
	export const LESS: string;
	export const XPC_FLAGS: string;
	export const INIT_CWD: string;
	export const LC_ALL: string;
	export const TERM_PROGRAM_VERSION: string;
	export const _: string;
	export const LOGNAME: string;
	export const ZSH: string;
	export const SECURITYSESSIONID: string;
	export const __CFBundleIdentifier: string;
	export const TMUX_PANE: string;
	export const DENO_INSTALL: string;
	export const HOME: string;
	export const HOMEBREW_REPOSITORY: string;
	export const LS_COLORS: string;
	export const OLDPWD: string;
	export const PATH: string;
	export const SHELL: string;
	export const SSH_AUTH_SOCK: string;
	export const __CF_USER_TEXT_ENCODING: string;
	export const NODE_ENV: string;
	export const PWD: string;
	export const WINDOWID: string;
	export const COMMAND_MODE: string;
	export const LaunchInstanceID: string;
	export const TERM_PROGRAM: string;
	export const COLORTERM: string;
	export const GOPATH: string;
	export const ALACRITTY_WINDOW_ID: string;
	export const INFOPATH: string;
	export const TMUX: string;
	export const npm_config_user_agent: string;
	export const ALACRITTY_SOCKET: string;
	export const ALACRITTY_LOG: string;
	export const BUN_INSTALL: string;
	export const SKYSPARK_PATH: string;
	export const TMPDIR: string;
}

/**
 * Similar to [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private), except that it only includes environment variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Values are replaced statically at build time.
 * 
 * ```ts
 * import { PUBLIC_BASE_URL } from '$env/static/public';
 * ```
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to runtime environment variables, as defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`. This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured).
 * 
 * This module cannot be imported into client-side code.
 * 
 * Dynamic environment variables cannot be used during prerendering.
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * console.log(env.DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 * 
 * > In `dev`, `$env/dynamic` always includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 */
declare module '$env/dynamic/private' {
	export const env: {
		USER: string;
		XPC_SERVICE_NAME: string;
		FPATH: string;
		HOMEBREW_CELLAR: string;
		HOMEBREW_PREFIX: string;
		LSCOLORS: string;
		TERM: string;
		PAGER: string;
		SHLVL: string;
		TMUX_PLUGIN_MANAGER_PATH: string;
		LESS: string;
		XPC_FLAGS: string;
		INIT_CWD: string;
		LC_ALL: string;
		TERM_PROGRAM_VERSION: string;
		_: string;
		LOGNAME: string;
		ZSH: string;
		SECURITYSESSIONID: string;
		__CFBundleIdentifier: string;
		TMUX_PANE: string;
		DENO_INSTALL: string;
		HOME: string;
		HOMEBREW_REPOSITORY: string;
		LS_COLORS: string;
		OLDPWD: string;
		PATH: string;
		SHELL: string;
		SSH_AUTH_SOCK: string;
		__CF_USER_TEXT_ENCODING: string;
		NODE_ENV: string;
		PWD: string;
		WINDOWID: string;
		COMMAND_MODE: string;
		LaunchInstanceID: string;
		TERM_PROGRAM: string;
		COLORTERM: string;
		GOPATH: string;
		ALACRITTY_WINDOW_ID: string;
		INFOPATH: string;
		TMUX: string;
		npm_config_user_agent: string;
		ALACRITTY_SOCKET: string;
		ALACRITTY_LOG: string;
		BUN_INSTALL: string;
		SKYSPARK_PATH: string;
		TMPDIR: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * Similar to [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private), but only includes variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`), and can therefore safely be exposed to client-side code.
 * 
 * Note that public dynamic environment variables must all be sent from the server to the client, causing larger network requests — when possible, use `$env/static/public` instead.
 * 
 * Dynamic environment variables cannot be used during prerendering.
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.PUBLIC_DEPLOYMENT_SPECIFIC_VARIABLE);
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
