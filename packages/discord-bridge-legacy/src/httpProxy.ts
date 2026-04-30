import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

/**
 * Undici is Node's built-in HTTP 1.1 client. `setGlobalDispatcher`
 * configures Node to proxy all HTTP requests through the given
 * agent, in this case `EnvHttpProxyAgent`. This is like `dotenv`
 * in that it loads environment variables: specifically `HTTP_PROXY`,
 * `HTTPS_PROXY` and `NO_PROXY` and uses these to build a
 * configuration. These can be set in e.g. the Docker container.
 */

setGlobalDispatcher(new EnvHttpProxyAgent());
