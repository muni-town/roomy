
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
	export const LS_COLORS: string;
	export const __CF_USER_TEXT_ENCODING: string;
	export const URL: string;
	export const NETLIFY_LOCAL: string;
	export const SUDO_USER: string;
	export const COLORTERM: string;
	export const SITE_ID: string;
	export const CONTEXT: string;
	export const PWD: string;
	export const LANGUAGE: string;
	export const HOME: string;
	export const SUDO_UID: string;
	export const BUILD_ID: string;
	export const LANG: string;
	export const TERM: string;
	export const LOGNAME: string;
	export const _: string;
	export const NODE_ENV: string;
	export const PATH: string;
	export const SITE_NAME: string;
	export const BRANCH: string;
	export const NEXT_TELEMETRY_DISABLED: string;
	export const GATSBY_TELEMETRY_DISABLED: string;
	export const DEPLOY_URL: string;
	export const FORCE_COLOR: string;
	export const SHELL: string;
	export const DEPLOY_ID: string;
	export const MAIL: string;
	export const DEPLOY_PRIME_URL: string;
	export const SSH_AUTH_SOCK: string;
	export const CACHED_COMMIT_REF: string;
	export const INIT_CWD: string;
	export const npm_config_user_agent: string;
	export const SUDO_COMMAND: string;
	export const LSCOLORS: string;
	export const HEAD: string;
	export const COMMIT_REF: string;
	export const NETLIFY_CLI_VERSION: string;
	export const SHLVL: string;
	export const LC_ALL: string;
	export const REPOSITORY_URL: string;
	export const PULL_REQUEST: string;
	export const SUDO_GID: string;
	export const USER: string;
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
		LS_COLORS: string;
		__CF_USER_TEXT_ENCODING: string;
		URL: string;
		NETLIFY_LOCAL: string;
		SUDO_USER: string;
		COLORTERM: string;
		SITE_ID: string;
		CONTEXT: string;
		PWD: string;
		LANGUAGE: string;
		HOME: string;
		SUDO_UID: string;
		BUILD_ID: string;
		LANG: string;
		TERM: string;
		LOGNAME: string;
		_: string;
		NODE_ENV: string;
		PATH: string;
		SITE_NAME: string;
		BRANCH: string;
		NEXT_TELEMETRY_DISABLED: string;
		GATSBY_TELEMETRY_DISABLED: string;
		DEPLOY_URL: string;
		FORCE_COLOR: string;
		SHELL: string;
		DEPLOY_ID: string;
		MAIL: string;
		DEPLOY_PRIME_URL: string;
		SSH_AUTH_SOCK: string;
		CACHED_COMMIT_REF: string;
		INIT_CWD: string;
		npm_config_user_agent: string;
		SUDO_COMMAND: string;
		LSCOLORS: string;
		HEAD: string;
		COMMIT_REF: string;
		NETLIFY_CLI_VERSION: string;
		SHLVL: string;
		LC_ALL: string;
		REPOSITORY_URL: string;
		PULL_REQUEST: string;
		SUDO_GID: string;
		USER: string;
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
