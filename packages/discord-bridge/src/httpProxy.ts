import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
setGlobalDispatcher(new EnvHttpProxyAgent());
